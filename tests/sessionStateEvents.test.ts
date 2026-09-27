import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { HumanMessage } from '@langchain/core/messages';
import type { IDataObject } from 'n8n-workflow';
import { runItems } from '../nodes/ClaudeCode/ClaudeCode.node';
import { supplyChatModel } from '../nodes/ClaudeCodeChatModel/ClaudeCodeChatModel.node';
import type { ClaudeCodeChat } from '../nodes/ClaudeCodeChatModel/model';
import { supplyClaudeCodeTool } from '../nodes/ClaudeCodeTool/ClaudeCodeTool.node';
import { claudeCodeParams, createFakeContext, type ParamMap } from './helpers/executeFunctions';
import { withFakeQuery, type FakeQueryOptions } from './helpers/fakeQuery';
import {
	backgroundSubagentPending,
	backgroundSubagentRun,
	FINAL_TEXT,
	streams,
	successResult,
	withSessionStates,
	wrapUpResult,
} from './helpers/sdkMessages';
import { createFakeSupplyContext } from './helpers/supplyDataFunctions';

// The versions that answer from the final result ask the CLI for session-state events to know
// when the run is over. The events decide that and nothing else: what the node emits is the same
// as for the stream without them.

const EVENT = /session_state_changed/;

describe('Claude Code 1.4 — session-state events are not emitted', () => {
	async function exec(params: ParamMap, query: FakeQueryOptions) {
		const fake = createFakeContext({
			typeVersion: 1.4,
			continueOnFail: true,
			params: claudeCodeParams({ ...params, additionalOptions: { debug: true } }),
		});
		const result = await withFakeQuery(query, (_record, fakeQuery) =>
			runItems(fake.ctx, { query: fakeQuery }),
		);
		return { json: result[0][0].json, logs: fake.logs };
	}

	for (const outputFormat of ['structured', 'messages', 'text']) {
		for (const [name, stream] of [
			['a background subagent', backgroundSubagentRun],
			['a plain run', streams.success],
		] as const) {
			it(`${outputFormat}, ${name}: the same output as without the events`, async () => {
				const plain = await exec({ outputFormat }, { messages: stream() });
				const withEvents = await exec({ outputFormat }, { messages: withSessionStates(stream()) });
				assert.doesNotMatch(JSON.stringify(withEvents.json), EVENT);
				assert.deepEqual(withEvents.json, plain.json);
			});
		}
	}

	it('the first message is still init, and the debug log does not list the events', async () => {
		const { json, logs } = await exec(
			{ outputFormat: 'structured' },
			{ messages: withSessionStates(backgroundSubagentRun()) },
		);
		const first = (json.messages as IDataObject[])[0];
		assert.equal(first.subtype, 'init');
		assert.doesNotMatch(JSON.stringify(logs), EVENT);
	});

	it('a timeout report counts the same messages', async () => {
		const timedOut = (messages: SDKMessage[]) =>
			exec(
				{ outputFormat: 'structured', timeout: 2, additionalOptions: { wrapUpGraceSeconds: 1 } },
				{ messages, hang: true, afterInterrupt: [successResult({ result: null }), wrapUpResult] },
			);
		const plain = await timedOut(backgroundSubagentPending());
		const withEvents = await timedOut(withSessionStates(backgroundSubagentPending()));
		const countOf = (json: IDataObject) => JSON.stringify(json).match(/"messageCount":\d+/g);
		assert.ok(countOf(plain.json), 'the timeout report carries a messageCount');
		assert.deepEqual(countOf(withEvents.json), countOf(plain.json));
		assert.doesNotMatch(JSON.stringify(withEvents.json), EVENT);
	});
});

/** A query that replays the scripted stream. */
const script = (messages: SDKMessage[]): typeof sdkQuery =>
	((_input: unknown) => {
		const generator = (async function* () {
			for (const message of messages) yield message;
		})();
		return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
	}) as unknown as typeof sdkQuery;

const reportOptions = { reportUsageTo: 'wf-collector', debug: true };

describe('Chat Model 1.1 — session-state events are not emitted', () => {
	async function answer(messages: SDKMessage[]) {
		const fake = createFakeSupplyContext({
			typeVersion: 1.1,
			params: {
				model: 'claude-sonnet-5',
				authSource: 'host',
				projectPath: '',
				options: reportOptions,
			},
		});
		const supplied = await supplyChatModel(fake.supplyCtx, { query: script(messages) }, 0);
		const reply = await (supplied.response as ClaudeCodeChat).invoke([
			new HumanMessage('codeword?'),
		]);
		return {
			reply: {
				content: reply.content,
				response_metadata: reply.response_metadata,
				usage_metadata: reply.usage_metadata,
			},
			runData: fake.runData,
			reports: fake.workflowCalls,
			logs: fake.logs,
		};
	}

	it('the reply, the run log and the usage report match the stream without the events', async () => {
		const plain = await answer(backgroundSubagentRun());
		const withEvents = await answer(withSessionStates(backgroundSubagentRun()));
		assert.equal(withEvents.reply.content, FINAL_TEXT);
		assert.doesNotMatch(JSON.stringify(withEvents), EVENT);
		assert.deepEqual(withEvents.reply, plain.reply);
		assert.deepEqual(withEvents.runData, plain.runData);
		assert.deepEqual(withEvents.reports, plain.reports);
	});
});

describe('Task Tool 1.1 — session-state events are not emitted', () => {
	async function answer(messages: SDKMessage[]) {
		const fake = createFakeSupplyContext({
			typeVersion: 1.1,
			params: {
				toolDescription: 'x',
				model: 'claude-sonnet-5',
				authSource: 'host',
				projectPath: '',
				options: reportOptions,
			},
		});
		const supplied = await supplyClaudeCodeTool(fake.supplyCtx, { query: script(messages) }, 0);
		const text = await (supplied.response as { invoke: (v: unknown) => Promise<string> }).invoke({
			task: 'get the codeword',
		});
		return { text, runData: fake.runData, reports: fake.workflowCalls, logs: fake.logs };
	}

	it('the answer, the run log and the usage report match the stream without the events', async () => {
		const plain = await answer(backgroundSubagentRun());
		const withEvents = await answer(withSessionStates(backgroundSubagentRun()));
		assert.equal(withEvents.text, FINAL_TEXT);
		assert.doesNotMatch(JSON.stringify(withEvents), EVENT);
		assert.deepEqual(withEvents.text, plain.text);
		assert.deepEqual(withEvents.runData, plain.runData);
		assert.deepEqual(withEvents.reports, plain.reports);
	});
});
