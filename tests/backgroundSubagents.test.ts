import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { HumanMessage } from '@langchain/core/messages';
import type { IDataObject } from 'n8n-workflow';
import { runItems } from '../nodes/ClaudeCode/ClaudeCode.node';
import { claudeCodeDescription } from '../nodes/ClaudeCode/description/properties';
import { buildOutputItem } from '../nodes/ClaudeCode/output';
import { supplyChatModel } from '../nodes/ClaudeCodeChatModel/ClaudeCodeChatModel.node';
import { claudeCodeChatModelDescription } from '../nodes/ClaudeCodeChatModel/description';
import type { ClaudeCodeChat } from '../nodes/ClaudeCodeChatModel/model';
import { supplyClaudeCodeTool } from '../nodes/ClaudeCodeTool/ClaudeCodeTool.node';
import { claudeCodeToolDescription } from '../nodes/ClaudeCodeTool/description';
import { claudeCodeParams, createFakeContext, type ParamMap } from './helpers/executeFunctions';
import { createFakeQuery, withFakeQuery, type FakeQueryOptions } from './helpers/fakeQuery';
import {
	backgroundSubagentPending,
	backgroundSubagentRun,
	FINAL_TEXT,
	INTERIM_TEXT,
	successResult,
	wrapUpResult,
} from './helpers/sdkMessages';
import { createFakeSupplyContext } from './helpers/supplyDataFunctions';

// When a subagent runs in the background the CLI writes a result for the turn that launched it
// and another once the subagent reports back. The versions below answer from the last one.

/** A stream that stays open with the subagent still out, so the graceful timeout has to decide. */
const pendingAtTimeout = (): FakeQueryOptions => ({
	messages: backgroundSubagentPending(),
	hang: true,
	afterInterrupt: [successResult({ result: null }), wrapUpResult],
});

describe('Claude Code — declared versions', () => {
	it('adds 1.4 and makes it the default, keeping every earlier version', () => {
		assert.deepEqual(claudeCodeDescription.version, [1, 1.1, 1.2, 1.3, 1.4]);
		assert.equal(claudeCodeDescription.defaultVersion, 1.4);
	});
});

describe('Claude Code — a run whose subagent went to the background', () => {
	async function exec(typeVersion: number, params: ParamMap = {}, query?: FakeQueryOptions) {
		const fake = createFakeContext({
			typeVersion,
			continueOnFail: true,
			params: claudeCodeParams(params),
		});
		const { result, record } = await withFakeQuery(
			query ?? { messages: backgroundSubagentRun() },
			async (record, fakeQuery) => ({
				result: await runItems(fake.ctx, { query: fakeQuery }),
				record,
			}),
		);
		return { json: result[0][0].json, record };
	}

	it('1.3 keeps answering from the first result, as it does today', async () => {
		const { json } = await exec(1.3, { outputFormat: 'structured' });
		assert.equal(json.result, INTERIM_TEXT);
		assert.equal((json.metrics as IDataObject).total_cost_usd, 0.0517);
		assert.deepEqual((json.diagnostics as IDataObject).modelsUsed, ['claude-sonnet-5']);
	});

	it('1.4 answers from the final result', async () => {
		const { json } = await exec(1.4, { outputFormat: 'structured' });
		assert.equal(json.result, FINAL_TEXT);
		assert.equal(json.success, true);
		assert.equal(json.errorText, '');
		assert.equal((json.metrics as IDataObject).total_cost_usd, 0.0517);
		assert.deepEqual((json.diagnostics as IDataObject).modelsUsed, [
			'claude-sonnet-5',
			'claude-haiku-5',
		]);
		assert.equal((json.summary as IDataObject).resultTextSource, 'result');
		assert.equal((json.messages as unknown[]).length, backgroundSubagentRun().length);
	});

	it('1.4 answers from the final result in the text format too', async () => {
		const { json } = await exec(1.4, { outputFormat: 'text' });
		assert.equal(json.result, FINAL_TEXT);
	});

	it('the Unified envelope on an older node keeps the first result', async () => {
		const { json } = await exec(1.1, {
			outputFormat: 'text',
			additionalOptions: { outputEnvelope: 'unified' },
		});
		assert.equal(json.result, INTERIM_TEXT);
	});

	it('1.4: the graceful timeout waits for a pending subagent instead of bailing on the interim result', async () => {
		const { record, json } = await exec(
			1.4,
			{ timeout: 2, additionalOptions: { wrapUpGraceSeconds: 1 } },
			pendingAtTimeout(),
		);
		assert.equal(record.interruptCount, 1);
		assert.match(JSON.stringify(json), /timeout_graceful/);
	});

	it('1.3: the same stream keeps today behaviour — no wrap-up, a hard abort', async () => {
		const { record, json } = await exec(
			1.3,
			{ timeout: 2, additionalOptions: { wrapUpGraceSeconds: 1 } },
			pendingAtTimeout(),
		);
		assert.equal(record.interruptCount, 0);
		assert.match(JSON.stringify(json), /timeout_hard_abort/);
	});
});

describe('buildOutputItem — the final-result switch', () => {
	const build = (finalResultOnly: boolean | undefined) =>
		buildOutputItem({
			nodeVersion: 1.4,
			format: 'text',
			messages: backgroundSubagentRun(),
			diagnostics: null,
			includeTranscript: false,
			finalResultOnly,
		});

	it('reads the final result when asked', () => {
		assert.equal(build(true).result, FINAL_TEXT);
	});

	it('reads the first result otherwise', () => {
		assert.equal(build(undefined).result, INTERIM_TEXT);
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

describe('Chat Model — a run whose subagent went to the background', () => {
	it('adds 1.1 and makes it the default, keeping 1', () => {
		assert.deepEqual(claudeCodeChatModelDescription.version, [1, 1.1]);
		assert.equal(claudeCodeChatModelDescription.defaultVersion, 1.1);
	});

	async function answer(typeVersion: number, query: typeof sdkQuery, options: IDataObject = {}) {
		const fake = createFakeSupplyContext({
			typeVersion,
			params: { model: 'claude-sonnet-5', authSource: 'host', projectPath: '', options },
		});
		const supplied = await supplyChatModel(fake.supplyCtx, { query }, 0);
		return (supplied.response as ClaudeCodeChat).invoke([new HumanMessage('codeword?')]);
	}

	it('1 keeps answering from the first result', async () => {
		const reply = await answer(1, script(backgroundSubagentRun()));
		assert.equal(reply.content, INTERIM_TEXT);
	});

	it('1.1 answers from the final result', async () => {
		const reply = await answer(1.1, script(backgroundSubagentRun()));
		assert.equal(reply.content, FINAL_TEXT);
	});

	for (const [version, interrupts] of [
		[1, 0],
		[1.1, 1],
	] as const) {
		it(`${version}: the graceful timeout ${interrupts ? 'waits for' : 'bails on'} a pending subagent`, async () => {
			const { fake, record } = createFakeQuery(pendingAtTimeout());
			await assert.rejects(
				answer(version, fake, { timeout: 2, wrapUpGraceSeconds: 1 }),
				/timed out/,
			);
			assert.equal(record.interruptCount, interrupts);
		});
	}
});

describe('Task Tool — a run whose subagent went to the background', () => {
	it('adds 1.1 and makes it the default, keeping 1', () => {
		assert.deepEqual(claudeCodeToolDescription.version, [1, 1.1]);
		assert.equal(claudeCodeToolDescription.defaultVersion, 1.1);
	});

	async function answer(typeVersion: number, query: typeof sdkQuery, options: IDataObject = {}) {
		const fake = createFakeSupplyContext({
			typeVersion,
			params: {
				toolDescription: 'x',
				model: 'claude-sonnet-5',
				authSource: 'host',
				projectPath: '',
				options,
			},
		});
		const supplied = await supplyClaudeCodeTool(fake.supplyCtx, { query }, 0);
		return (supplied.response as { invoke: (v: unknown) => Promise<string> }).invoke({
			task: 'get the codeword',
		});
	}

	it('1 keeps answering from the first result', async () => {
		assert.equal(await answer(1, script(backgroundSubagentRun())), INTERIM_TEXT);
	});

	it('1.1 answers from the final result', async () => {
		assert.equal(await answer(1.1, script(backgroundSubagentRun())), FINAL_TEXT);
	});

	for (const [version, interrupts] of [
		[1, 0],
		[1.1, 1],
	] as const) {
		it(`${version}: the graceful timeout ${interrupts ? 'waits for' : 'bails on'} a pending subagent`, async () => {
			const { fake, record } = createFakeQuery(pendingAtTimeout());
			const text = await answer(version, fake, { timeout: 2, wrapUpGraceSeconds: 1 });
			assert.match(text, /timed out/);
			assert.equal(record.interruptCount, interrupts);
		});
	}
});
