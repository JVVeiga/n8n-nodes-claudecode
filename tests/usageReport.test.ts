import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { IDataObject } from 'n8n-workflow';
import { HumanMessage } from '@langchain/core/messages';
import { supplyChatModel } from '../nodes/ClaudeCodeChatModel/ClaudeCodeChatModel.node';
import { ClaudeCodeChat } from '../nodes/ClaudeCodeChatModel/model';
import { supplyClaudeCodeTool } from '../nodes/ClaudeCodeTool/ClaudeCodeTool.node';
import { buildRunKey } from '../nodes/shared/usageReport';
import { buildRunMetrics } from '../nodes/ClaudeCode/output/metrics';
import { buildDiagnostics } from '../nodes/ClaudeCode/diagnostics';
import { buildV12Output } from '../nodes/ClaudeCode/output/v12';
import { createFakeSupplyContext } from './helpers/supplyDataFunctions';

/**
 * A sub-node's output is unreachable by expressions, so usage leaves by calling a collector
 * workflow. What matters is that the payload is the SAME shape the main node emits — a
 * collector built for the main node must consume a sub-node's run without knowing the
 * difference — and that a collector failing never costs the caller their answer.
 */

const msg = (value: unknown): SDKMessage => value as SDKMessage;

const RESULT = {
	type: 'result',
	subtype: 'success',
	result: 'pong',
	session_id: 'sess-42',
	duration_ms: 1234,
	num_turns: 3,
	total_cost_usd: 0.0777,
	// Passed through verbatim: a collector reads deep into these, and normalising here would
	// silently drop fields the SDK adds later.
	usage: {
		input_tokens: 100,
		output_tokens: 20,
		cache_read_input_tokens: 7,
		cache_creation: { ephemeral_1h_input_tokens: 3 },
		server_tool_use: { web_search_requests: 2 },
		service_tier: 'standard',
	},
	modelUsage: {
		'claude-sonnet-5': {
			inputTokens: 100,
			outputTokens: 20,
			cacheReadInputTokens: 7,
			cacheCreationInputTokens: 3,
		},
	},
};

const happyRun = [
	msg({ type: 'system', subtype: 'init', session_id: 'sess-42', model: 'claude-sonnet-5' }),
	msg({
		type: 'assistant',
		session_id: 'sess-42',
		message: { content: [{ type: 'text', text: 'pong' }] },
	}),
	msg(RESULT),
];

const script = (messages: SDKMessage[] = happyRun): typeof sdkQuery =>
	((_: unknown) => {
		const generator = (async function* () {
			for (const message of messages) yield message;
		})();
		return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
	}) as unknown as typeof sdkQuery;

const chatParams = (over: Record<string, unknown> = {}) => ({
	model: 'claude-sonnet-5',
	authSource: 'host',
	projectPath: '',
	options: { reportUsageTo: 'collector-wf', processName: 'support-bot' },
	...over,
});

const toolParams = (over: Record<string, unknown> = {}) => ({
	toolDescription: 'Runs a task',
	model: 'claude-sonnet-5',
	authSource: 'host',
	projectPath: '',
	options: { reportUsageTo: 'collector-wf', processName: 'support-bot' },
	...over,
});

const payloadOf = (call: { payload: unknown }) => call.payload as IDataObject;

/** A params object shaped like the main node's, to compare diagnostics field sets against. */
const mainNodeParams = () =>
	({
		operation: 'query',
		sessionId: '',
		prompt: '',
		model: 'claude-sonnet-5',
		effort: 'high',
		maxTurns: 25,
		timeoutSeconds: 300,
		projectPath: '',
		outputFormat: 'text',
		allowedTools: [],
		disallowedTools: [],
		restrictTools: [],
		attachments: {
			all: false,
			names: [],
			inlineTextLimitKb: 256,
			maxAttachmentMb: 50,
			maxAttachmentCount: 16,
			allowedExtensions: [],
		},
		additional: { permissionMode: 'bypassPermissions', wrapUpGraceSeconds: 60 },
		nodeVersion: 1.3,
		itemIndex: 0,
	}) as never;

describe('the report is the SAME shape the main node emits', () => {
	it('metrics matches buildV12Output field for field', () => {
		const v12 = buildV12Output({
			format: 'text',
			messages: happyRun,
			diagnostics: null,
			includeTranscript: false,
			durationMs: 9999,
		});
		assert.deepEqual(buildRunMetrics(happyRun, 9999), v12.metrics);
	});

	it('usage and modelUsage pass through verbatim — a collector reads deep into them', () => {
		const metrics = buildRunMetrics(happyRun, 0) as IDataObject;
		assert.deepEqual(metrics.usage, RESULT.usage);
		assert.deepEqual(metrics.modelUsage, RESULT.modelUsage);
		assert.equal(metrics.session_id, 'sess-42');
		assert.equal(metrics.total_cost_usd, 0.0777);
	});

	it('an unknown cost is null, never a zero standing in for it', () => {
		const noResult = [happyRun[0], happyRun[1]];
		const metrics = buildRunMetrics(noResult, 500) as IDataObject;
		assert.equal(metrics.total_cost_usd, null);
		assert.equal(metrics.num_turns, null);
		assert.equal(metrics.duration_ms, 500, 'the measured wall time, which is real');
	});
});

describe('run_key identifies a call, not a session', () => {
	it('is execution + node + item + sequence', () => {
		assert.equal(
			buildRunKey('123', 'Claude Code Chat Model', 0, 2),
			'123:Claude Code Chat Model:0:2',
		);
	});

	it('every axis that can repeat is in the key', () => {
		// The session id cannot do this job: a resumed conversation carries the same one across
		// executions, so keying on it makes every message overwrite the last.
		assert.notEqual(buildRunKey('1', 'X', 0, 1), buildRunKey('1', 'X', 0, 2), 'repeated calls');
		assert.notEqual(buildRunKey('1', 'X', 0, 1), buildRunKey('2', 'X', 0, 1), 'two executions');
		// itemIndex is defence rather than the working part: e2e case72 measured n8n supplying
		// ONCE for two items (both keys carried index 0, the sequence separated them). It is in
		// the key because supplyData takes an index and MAY be called per item, and then two
		// counters would both start at 1.
		assert.notEqual(buildRunKey('1', 'X', 0, 1), buildRunKey('1', 'X', 1, 1), 'two items');
	});
});

describe('the chat model reports each call', () => {
	it('sends process_name, run_key, caller ids, metrics and diagnostics', async () => {
		const fake = createFakeSupplyContext({
			params: chatParams(),
			executionId: 'exec-99',
			workflowId: 'wf-7',
			nodeName: 'CC Model',
		});
		const supplied = await supplyChatModel(fake.supplyCtx, { query: script() }, 0);
		await (supplied.response as ClaudeCodeChat).invoke([new HumanMessage('hi')]);

		assert.equal(fake.workflowCalls.length, 1);
		const call = fake.workflowCalls[0];
		assert.equal(call.workflowId, 'collector-wf');
		assert.equal(call.doNotWaitToFinish, true, 'the collector is off the critical path');

		const payload = payloadOf(call);
		assert.equal(payload.process_name, 'support-bot');
		assert.equal(payload.run_key, 'exec-99:CC Model:0:1');
		assert.equal(payload.caller_workflow_id, 'wf-7');
		assert.equal(payload.caller_execution_id, 'exec-99');
		assert.equal((payload.metrics as IDataObject).total_cost_usd, 0.0777);
		// Diagnostics parity by FIELD SET, not two spot checks: a collector reads a dozen of them,
		// and the promise is that a sub-node's object carries what the main node's does.
		const mainNodeShape = buildDiagnostics({
			messages: happyRun,
			params: mainNodeParams(),
			permissionMode: 'bypassPermissions',
			appliedEffort: null,
		}) as unknown as IDataObject;
		assert.deepEqual(
			Object.keys(payload.diagnostics as IDataObject).sort(),
			Object.keys(mainNodeShape).sort(),
			'same field set as the main node emits',
		);
		assert.equal((payload.diagnostics as IDataObject).resolvedModel, 'claude-sonnet-5');
	});

	it('numbers repeated calls within one execution', async () => {
		const fake = createFakeSupplyContext({ params: chatParams(), executionId: 'e1' });
		const supplied = await supplyChatModel(fake.supplyCtx, { query: script() }, 0);
		const model = supplied.response as ClaudeCodeChat;
		await model.invoke([new HumanMessage('one')]);
		await model.invoke([new HumanMessage('two')]);

		assert.deepEqual(
			fake.workflowCalls.map((c) => payloadOf(c).run_key),
			['e1:Claude Code:0:1', 'e1:Claude Code:0:2'],
		);
	});

	it('an empty Process Name falls back to the node name, never an unattributable row', async () => {
		const fake = createFakeSupplyContext({
			params: chatParams({ options: { reportUsageTo: 'collector-wf' } }),
			nodeName: 'Support Bot Model',
		});
		const supplied = await supplyChatModel(fake.supplyCtx, { query: script() }, 0);
		await (supplied.response as ClaudeCodeChat).invoke([new HumanMessage('hi')]);
		assert.equal(payloadOf(fake.workflowCalls[0]).process_name, 'Support Bot Model');
	});

	it('a workflow picked and then CLEARED means no reporting', async () => {
		// The workflowSelector leaves `{ __rl: true, value: '' }` behind rather than removing the
		// option — an empty pick must read as "off", not as a call to workflow "".
		const fake = createFakeSupplyContext({
			params: chatParams({
				options: { reportUsageTo: { __rl: true, value: '  ', mode: 'list' }, processName: 'x' },
			}),
		});
		const supplied = await supplyChatModel(fake.supplyCtx, { query: script() }, 0);
		await (supplied.response as ClaudeCodeChat).invoke([new HumanMessage('hi')]);
		assert.equal(fake.workflowCalls.length, 0);
	});

	it('reports nothing when no workflow was chosen', async () => {
		const fake = createFakeSupplyContext({ params: chatParams({ options: {} }) });
		const supplied = await supplyChatModel(fake.supplyCtx, { query: script() }, 0);
		await (supplied.response as ClaudeCodeChat).invoke([new HumanMessage('hi')]);
		assert.equal(fake.workflowCalls.length, 0);
	});

	it('a collector that fails does NOT cost the caller their answer', async () => {
		const fake = createFakeSupplyContext({
			params: chatParams(),
			executeWorkflowThrows: true,
		});
		const supplied = await supplyChatModel(fake.supplyCtx, { query: script() }, 0);
		const message = await (supplied.response as ClaudeCodeChat).invoke([new HumanMessage('hi')]);
		assert.equal(message.content, 'pong', 'the run survived the reporting failure');
	});
});

describe('the runs that cost most are the ones that must be reported', () => {
	it('chat model: a TIMED-OUT call reports before it throws', async () => {
		// It used to report after the timeout check, so the most expensive runs — the ones that
		// spent money and returned nothing — were the only ones missing from the table.
		const hanging = ((input: { options: { abortController: AbortController } }) => {
			const generator = (async function* () {
				yield happyRun[0];
				yield msg(RESULT);
				await new Promise<void>((resolve) =>
					input.options.abortController.signal.addEventListener('abort', () => resolve(), {
						once: true,
					}),
				);
			})();
			return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
		}) as unknown as typeof sdkQuery;

		const fake = createFakeSupplyContext({
			params: chatParams({
				options: {
					reportUsageTo: 'collector-wf',
					processName: 'support-bot',
					timeout: 1,
					wrapUpGraceSeconds: 0,
				},
			}),
		});
		const supplied = await supplyChatModel(fake.supplyCtx, { query: hanging }, 0);
		await assert.rejects((supplied.response as ClaudeCodeChat).invoke([new HumanMessage('hi')]));

		assert.equal(fake.workflowCalls.length, 1, 'the spend was reported anyway');
		assert.equal((payloadOf(fake.workflowCalls[0]).metrics as IDataObject).total_cost_usd, 0.0777);
	});

	it('chat model: the resume→create retry reports BOTH attempts', async () => {
		// Two CLI runs happened and both cost tokens; reporting only the survivor loses the first.
		const notFound = [
			happyRun[0],
			msg({ type: 'result', subtype: 'error_during_execution', session_id: 'x', num_turns: 0 }),
		];
		let call = 0;
		const twoPhase = ((_: unknown) => {
			const script_ = call++ === 0 ? notFound : happyRun;
			const generator = (async function* () {
				for (const message of script_) yield message;
			})();
			return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
		}) as unknown as typeof sdkQuery;

		const fake = createFakeSupplyContext({
			params: chatParams({
				memorySource: 'session',
				sessionId: 'a-key',
				options: { reportUsageTo: 'collector-wf', processName: 'support-bot' },
			}),
			executionId: 'e9',
		});
		const supplied = await supplyChatModel(fake.supplyCtx, { query: twoPhase }, 0);
		await (supplied.response as ClaudeCodeChat).invoke([new HumanMessage('hi')]);

		assert.equal(fake.workflowCalls.length, 2, 'one row per attempt');
		assert.deepEqual(
			fake.workflowCalls.map((c) => payloadOf(c).run_key),
			['e9:Claude Code:0:1', 'e9:Claude Code:0:2'],
		);
	});
});

describe('the task tool reports each call', () => {
	it('sends the same shape, keyed by its own node name', async () => {
		const fake = createFakeSupplyContext({
			params: toolParams(),
			executionId: 'exec-5',
			nodeName: 'Repo Inspector',
		});
		const supplied = await supplyClaudeCodeTool(fake.supplyCtx, { query: script() }, 0);
		await (supplied.response as { invoke: (v: unknown) => Promise<string> }).invoke({
			task: 'count files',
		});

		assert.equal(fake.workflowCalls.length, 1);
		const payload = payloadOf(fake.workflowCalls[0]);
		assert.equal(payload.run_key, 'exec-5:Repo Inspector:0:1');
		assert.equal(payload.node_name, 'Repo Inspector');
		assert.equal((payload.metrics as IDataObject).session_id, 'sess-42');
	});

	it('reports a TIMED-OUT run too — the one worth having in the table', async () => {
		const hanging = ((input: { options: { abortController: AbortController } }) => {
			const generator = (async function* () {
				yield happyRun[0];
				yield msg(RESULT);
				await new Promise<void>((resolve) =>
					input.options.abortController.signal.addEventListener('abort', () => resolve(), {
						once: true,
					}),
				);
			})();
			return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
		}) as unknown as typeof sdkQuery;

		const fake = createFakeSupplyContext({
			params: toolParams({
				options: {
					reportUsageTo: 'collector-wf',
					processName: 'support-bot',
					timeout: 1,
					wrapUpGraceSeconds: 0,
				},
			}),
		});
		const supplied = await supplyClaudeCodeTool(fake.supplyCtx, { query: hanging }, 0);
		const output = await (supplied.response as { invoke: (v: unknown) => Promise<string> }).invoke({
			task: 'x',
		});

		assert.match(output, /timed out/);
		assert.equal(fake.workflowCalls.length, 1, 'the spend was still reported');
		assert.equal((payloadOf(fake.workflowCalls[0]).metrics as IDataObject).total_cost_usd, 0.0777);
	});
});
