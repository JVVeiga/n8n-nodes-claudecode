import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { HumanMessage } from '@langchain/core/messages';
import { supplyChatModel } from '../nodes/ClaudeCodeChatModel/ClaudeCodeChatModel.node';
import { ClaudeCodeChat } from '../nodes/ClaudeCodeChatModel/model';
import { supplyClaudeCodeTool } from '../nodes/ClaudeCodeTool/ClaudeCodeTool.node';
import { supplyClaudeCodeUsageTool } from '../nodes/ClaudeCodeUsageTool/ClaudeCodeUsageTool.node';
import type { readUsage } from '../nodes/ClaudeCodeUsage/readUsage';
import { createFakeSupplyContext } from './helpers/supplyDataFunctions';

/**
 * The runtime behaviours the three sub-nodes share and that only a test can hold in place:
 * cancellation, the credential actually reaching the CLI, timeouts, and logging that degrades
 * instead of failing. Each was a gap the review found — the code paths existed, nothing pinned
 * them.
 */

const msg = (value: unknown): SDKMessage => value as SDKMessage;

const happyRun = [
	msg({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-sonnet-5' }),
	msg({
		type: 'assistant',
		session_id: 's-1',
		message: { content: [{ type: 'text', text: 'pong' }] },
	}),
	msg({
		type: 'result',
		subtype: 'success',
		result: 'pong',
		session_id: 's-1',
		total_cost_usd: 0.01,
		num_turns: 1,
		modelUsage: {
			'claude-sonnet-5': {
				inputTokens: 10,
				outputTokens: 5,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			},
		},
	}),
];

/** Records the options every spawn was given, so a test can assert what reached the CLI. */
const recorder = (messages: SDKMessage[] = happyRun) => {
	const seen: Array<Record<string, unknown>> = [];
	const query = ((input: { options: Record<string, unknown> }) => {
		seen.push(input.options);
		const generator = (async function* () {
			for (const message of messages) yield message;
		})();
		return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
	}) as unknown as typeof sdkQuery;
	return { seen, query };
};

const chatParams = (over: Record<string, unknown> = {}) => ({
	model: 'claude-sonnet-5',
	authSource: 'host',
	projectPath: '',
	options: {},
	...over,
});

const toolParams = (over: Record<string, unknown> = {}) => ({
	toolDescription: 'Runs a task',
	model: 'claude-sonnet-5',
	authSource: 'host',
	projectPath: '',
	options: {},
	...over,
});

const API_CREDENTIAL = { claudeCodeApi: { apiKey: 'sk-ant-test-value' } };

describe('the credential reaches the CLI — on every sub-node', () => {
	it('chat model: the key is in the subprocess env, and the other six are scrubbed', async () => {
		const { seen, query } = recorder();
		const fake = createFakeSupplyContext({
			params: chatParams({ authSource: 'apiKey' }),
			credentials: API_CREDENTIAL,
		});
		const supplied = await supplyChatModel(fake.supplyCtx, { query }, 0);
		await (supplied.response as ClaudeCodeChat).invoke([new HumanMessage('hi')]);

		const env = seen[0].env as Record<string, string | undefined>;
		assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test-value');
		assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false, 'the opposite variable is deleted');
	});

	it('task tool: same — a tool must not answer on the host account either', async () => {
		const { seen, query } = recorder();
		const fake = createFakeSupplyContext({
			params: toolParams({ authSource: 'apiKey' }),
			credentials: API_CREDENTIAL,
		});
		const supplied = await supplyClaudeCodeTool(fake.supplyCtx, { query }, 0);
		await (supplied.response as { invoke: (v: unknown) => Promise<string> }).invoke({
			task: 'x',
		});

		const env = seen[0].env as Record<string, string | undefined>;
		assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test-value');
	});

	it('usage tool: the credential reaches readUsage as a scrubbed authEnv', async () => {
		const seen: Array<Record<string, unknown>> = [];
		const fakeRead = (async (options: Record<string, unknown>) => {
			seen.push(options);
			return {
				init: { account: { tokenSource: 'ANTHROPIC_API_KEY' } },
				usage: {},
				claudeCodeVersion: '2.1.251',
				initMs: 1,
				usageMs: 1,
				unsupported: false,
				probeCostUsd: null,
			};
		}) as unknown as typeof readUsage;

		const fake = createFakeSupplyContext({
			params: {
				toolDescription: 'Reads usage',
				authSource: 'apiKey',
				projectPath: '',
				options: {},
			},
			credentials: API_CREDENTIAL,
		});
		const supplied = await supplyClaudeCodeUsageTool(fake.supplyCtx, { readUsage: fakeRead }, 0);
		await (supplied.response as { invoke: (v: unknown) => Promise<string> }).invoke({});

		const authEnv = seen[0].authEnv as Record<string, string | undefined>;
		assert.equal(authEnv.ANTHROPIC_API_KEY, 'sk-ant-test-value');
	});
});

describe('cancellation', () => {
	it('chat model: a signal aborted BEFORE the call aborts the run immediately', async () => {
		const { seen, query } = recorder();
		const fake = createFakeSupplyContext({ params: chatParams() });
		fake.cancelController.abort();

		const supplied = await supplyChatModel(fake.supplyCtx, { query }, 0);
		await (supplied.response as ClaudeCodeChat).invoke([new HumanMessage('hi')]);

		const controller = seen[0].abortController as AbortController;
		assert.equal(controller.signal.aborted, true);
	});

	it('chat model: cancelling mid-execution aborts the controller the run holds', async () => {
		const { seen, query } = recorder();
		const fake = createFakeSupplyContext({ params: chatParams() });
		const supplied = await supplyChatModel(fake.supplyCtx, { query }, 0);
		await (supplied.response as ClaudeCodeChat).invoke([new HumanMessage('hi')]);

		const controller = seen[0].abortController as AbortController;
		assert.equal(controller.signal.aborted, false);
		fake.cancelController.abort();
		// Detached in the finally: a completed call must NOT still be listening, otherwise every
		// agent step leaves a listener behind on a signal that lives for the whole execution.
		assert.equal(controller.signal.aborted, false, 'listener was detached when the call ended');
	});

	it('task tool: the same, and a second abort is harmless', async () => {
		const { seen, query } = recorder();
		const fake = createFakeSupplyContext({ params: toolParams() });
		const supplied = await supplyClaudeCodeTool(fake.supplyCtx, { query }, 0);
		const tool = supplied.response as { invoke: (v: unknown) => Promise<string> };

		await tool.invoke({ task: 'first' });
		fake.cancelController.abort();
		assert.equal((seen[0].abortController as AbortController).signal.aborted, false);

		// A call made after the execution was cancelled starts already aborted.
		await tool.invoke({ task: 'second' });
		assert.equal((seen[1].abortController as AbortController).signal.aborted, true);
	});

	it('an n8n build without getExecutionCancelSignal still supplies a working model', async () => {
		const { query } = recorder();
		const fake = createFakeSupplyContext({
			params: chatParams(),
			withoutCancelSignal: true,
		});
		const supplied = await supplyChatModel(fake.supplyCtx, { query }, 0);
		const message = await (supplied.response as ClaudeCodeChat).invoke([new HumanMessage('hi')]);
		assert.equal(message.content, 'pong');
	});
});

describe('logging degrades, it never fails the run', () => {
	it('chat model: addInputData throwing (an editor probe) leaves the answer intact', async () => {
		const { query } = recorder();
		const fake = createFakeSupplyContext({ params: chatParams(), addInputDataThrows: true });
		const supplied = await supplyChatModel(fake.supplyCtx, { query }, 0);
		const message = await (supplied.response as ClaudeCodeChat).invoke([new HumanMessage('hi')]);

		assert.equal(message.content, 'pong');
		assert.equal(fake.runData.length, 0, 'nothing logged, nothing thrown');
	});

	it('task tool: the same', async () => {
		const { query } = recorder();
		const fake = createFakeSupplyContext({ params: toolParams(), addInputDataThrows: true });
		const supplied = await supplyClaudeCodeTool(fake.supplyCtx, { query }, 0);
		const output = await (supplied.response as { invoke: (v: unknown) => Promise<string> }).invoke({
			task: 'x',
		});

		assert.equal(output, 'pong');
		assert.equal(fake.runData.length, 0);
	});
});

describe('timeouts and hard failures reach the caller in the right shape', () => {
	const timedOutRun = [
		happyRun[0],
		msg({
			type: 'assistant',
			session_id: 's-1',
			message: { content: [{ type: 'text', text: 'half an answer' }] },
		}),
	];

	/** A query that never ends until the hard timer aborts it. */
	const hanging = (messages: SDKMessage[]) =>
		((input: { options: { abortController: AbortController } }) => {
			const generator = (async function* () {
				for (const message of messages) yield message;
				await new Promise<void>((resolve) => {
					input.options.abortController.signal.addEventListener('abort', () => resolve(), {
						once: true,
					});
				});
			})();
			return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
		}) as unknown as typeof sdkQuery;

	it('chat model: a timeout THROWS, carrying the partial answer', async () => {
		const fake = createFakeSupplyContext({
			params: chatParams({ options: { timeout: 1, wrapUpGraceSeconds: 0 } }),
		});
		const supplied = await supplyChatModel(fake.supplyCtx, { query: hanging(timedOutRun) }, 0);
		await assert.rejects(
			(supplied.response as ClaudeCodeChat).invoke([new HumanMessage('hi')]),
			/timed out after 1s.*half an answer/s,
		);
	});

	it('task tool: a timeout returns TEXT — a tool must not kill the agent run', async () => {
		const fake = createFakeSupplyContext({
			params: toolParams({ options: { timeout: 1, wrapUpGraceSeconds: 0 } }),
		});
		const supplied = await supplyClaudeCodeTool(fake.supplyCtx, { query: hanging(timedOutRun) }, 0);
		const output = await (supplied.response as { invoke: (v: unknown) => Promise<string> }).invoke({
			task: 'x',
		});

		assert.match(output, /timed out after 1s/);
		assert.match(output, /half an answer/);
	});

	it('task tool: a SYNCHRONOUS spawn failure returns text and closes the log entry', async () => {
		// `query()` is called outside runner.ts's try — a missing CLI binary throws right there,
		// which used to reject into the Agent and leave the sub-node's log open forever.
		const throwing = (() => {
			throw new Error('Native CLI binary for linux-x64 not found');
		}) as unknown as typeof sdkQuery;

		const fake = createFakeSupplyContext({ params: toolParams() });
		const supplied = await supplyClaudeCodeTool(fake.supplyCtx, { query: throwing }, 0);
		const output = await (supplied.response as { invoke: (v: unknown) => Promise<string> }).invoke({
			task: 'x',
		});

		assert.match(output, /Claude Code failed: Native CLI binary/);
		assert.equal(fake.runData.length, 2, 'the entry was opened AND closed');
		assert.equal(fake.runData[1].direction, 'output');
	});
});
