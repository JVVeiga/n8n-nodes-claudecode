import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { HumanMessage } from '@langchain/core/messages';
import { NodeConnectionType } from 'n8n-workflow';
import {
	ClaudeCodeChatModel,
	supplyChatModel,
} from '../nodes/ClaudeCodeChatModel/ClaudeCodeChatModel.node';
import { ClaudeCodeChat } from '../nodes/ClaudeCodeChatModel/model';
import { createFakeSupplyContext } from './helpers/supplyDataFunctions';

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
				inputTokens: 50,
				outputTokens: 10,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			},
		},
	}),
];

const script = (messages: SDKMessage[], seen: unknown[] = []): typeof sdkQuery =>
	((input: { options: unknown }) => {
		seen.push(input.options);
		const generator = (async function* () {
			for (const message of messages) yield message;
		})();
		return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
	}) as unknown as typeof sdkQuery;

const chatModelParams = (over: Record<string, unknown> = {}) => ({
	model: 'claude-sonnet-5',
	authSource: 'host',
	projectPath: '',
	options: {},
	...over,
});

describe('the node description — what the editor sees', () => {
	const description = new ClaudeCodeChatModel().description;

	it('is a sub-node: no main input, one ai_languageModel output', () => {
		assert.deepEqual(description.inputs, []);
		assert.deepEqual(description.outputs, [{ type: NodeConnectionType.AiLanguageModel }]);
	});

	it('carries the shared authentication selector and both credential types', () => {
		assert.deepEqual(
			(description.credentials ?? []).map((c) => c.name),
			['claudeCodeApi', 'claudeCodeOAuthTokenApi'],
		);
		const auth = description.properties.find((p) => p.name === 'authSource');
		assert.ok(auth, 'authSource present — the reserved name `authentication` is a known trap');
	});

	it('is named claudeCodeChatModel, version 1', () => {
		assert.equal(description.name, 'claudeCodeChatModel');
		assert.equal(description.version, 1);
	});
});

describe('supplyData — what the Agent receives', () => {
	it('supplies a model that passes the Agent’s gate', async () => {
		const fake = createFakeSupplyContext({ params: chatModelParams() });
		const supplied = await supplyChatModel(fake.supplyCtx, { query: script(happyRun) }, 0);
		const model = supplied.response as ClaudeCodeChat;
		assert.ok(model instanceof ClaudeCodeChat);
		assert.ok(model.lc_namespace.includes('chat_models'));
		assert.equal(typeof model.bindTools, 'function');
	});

	it('fails in supplyData — before the Agent runs — when a credential mode has none selected', async () => {
		const fake = createFakeSupplyContext({
			params: chatModelParams({ authSource: 'apiKey' }),
		});
		await assert.rejects(
			supplyChatModel(fake.supplyCtx, { query: script([]) }, 0),
			/No credential selected/,
		);
	});

	it('Session mode with an empty Session ID fails in supplyData, not silently stateless', async () => {
		const fake = createFakeSupplyContext({
			params: chatModelParams({ memorySource: 'session', sessionId: '' }),
		});
		await assert.rejects(
			supplyChatModel(fake.supplyCtx, { query: script([]) }, 0),
			/Session ID is empty/,
		);
	});

	it('Memory mode supplies a model that does not resume, whatever the field holds', async () => {
		const seen: Array<{ resume?: string }> = [];
		const fake = createFakeSupplyContext({
			params: chatModelParams({ memorySource: 'memory', sessionId: 'discord:leftover' }),
		});
		const supplied = await supplyChatModel(fake.supplyCtx, { query: script(happyRun, seen) }, 0);
		const model = supplied.response as ClaudeCodeChat;
		await model.invoke([new HumanMessage('hi')]);
		// `seen.length` first: with `?.` alone this passed when query was never called at all.
		assert.equal(seen.length, 1, 'the run happened');
		assert.equal(seen[0].resume, undefined, 'no resume in Memory mode');
	});

	it('R10: a run writes the input/output pair into the sub-node’s log, tokens included', async () => {
		const fake = createFakeSupplyContext({ params: chatModelParams() });
		const supplied = await supplyChatModel(fake.supplyCtx, { query: script(happyRun) }, 0);
		const model = supplied.response as ClaudeCodeChat;

		await model.invoke([new HumanMessage('ping?')]);

		assert.equal(fake.runData.length, 2);
		assert.equal(fake.runData[0].direction, 'input');
		assert.equal(fake.runData[1].direction, 'output');
		assert.equal(fake.runData[1].index, fake.runData[0].index);
		const output = (
			fake.runData[1].payload as Array<Array<{ json: Record<string, unknown> }>>
		)[0][0].json;
		assert.equal(output.response, 'pong');
		assert.deepEqual(output.tokenUsage, {
			promptTokens: 50,
			completionTokens: 10,
			totalTokens: 60,
		});
	});

	it('R10 on failure: the error lands in the log too', async () => {
		const failing = ((_: unknown) => {
			const generator = (async function* () {
				yield happyRun[0];
				throw new Error('spawn failed');
			})();
			return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
		}) as unknown as typeof sdkQuery;

		const fake = createFakeSupplyContext({ params: chatModelParams() });
		const supplied = await supplyChatModel(fake.supplyCtx, { query: failing }, 0);
		const model = supplied.response as ClaudeCodeChat;

		await assert.rejects(model.invoke([new HumanMessage('hi')]), /spawn failed/);
		assert.equal(fake.runData.length, 2);
		assert.equal(fake.runData[1].direction, 'output');
		// The ERROR shape is the point of log.error — an ordinary data array would mean the panel
		// showed the call as succeeding.
		const payload = fake.runData[1].payload as { message?: string };
		assert.ok(payload instanceof Error, 'an error object, not a data array');
		assert.match(String(payload.message), /spawn failed/);
	});
});
