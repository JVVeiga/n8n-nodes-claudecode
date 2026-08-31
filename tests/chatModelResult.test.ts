import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolveChatOutcome } from '../nodes/ClaudeCodeChatModel/result';

/** Hand-built SDK messages, cast structurally like every other suite in this repo does. */
const msg = (value: unknown): SDKMessage => value as SDKMessage;

const init = msg({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-sonnet-5' });

const assistantText = (text: string) =>
	msg({ type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text }] } });

const success = (over: Record<string, unknown> = {}) =>
	msg({
		type: 'result',
		subtype: 'success',
		result: 'the answer',
		session_id: 's-1',
		total_cost_usd: 0.0123,
		num_turns: 3,
		modelUsage: {
			'claude-sonnet-5': {
				inputTokens: 100,
				outputTokens: 40,
				cacheReadInputTokens: 10,
				cacheCreationInputTokens: 5,
			},
		},
		...over,
	});

const formatCall = (args: Record<string, unknown>, id: string) =>
	msg({
		type: 'assistant',
		session_id: 's-1',
		message: {
			content: [
				{ type: 'tool_use', name: 'mcp__n8n__format_final_json_response', id, input: args },
			],
		},
	});

describe('resolveChatOutcome — the plain answer', () => {
	it('text, usage, cost, session and resolved model come from the stream', () => {
		const outcome = resolveChatOutcome([init, assistantText('the answer'), success()]);
		assert.equal(outcome.text, 'the answer');
		assert.deepEqual(outcome.toolCalls, []);
		assert.deepEqual(outcome.usage, {
			inputTokens: 100,
			outputTokens: 40,
			cacheReadInputTokens: 10,
			cacheCreationInputTokens: 5,
		});
		assert.equal(outcome.totalCostUsd, 0.0123);
		assert.equal(outcome.numTurns, 3);
		assert.equal(outcome.sessionId, 's-1');
		assert.equal(outcome.model, 'claude-sonnet-5');
	});

	it('no result message: usage is null (never fabricated), text falls back to the transcript', () => {
		const outcome = resolveChatOutcome([init, assistantText('partial words')]);
		assert.equal(outcome.text, 'partial words');
		assert.equal(outcome.usage, null);
		assert.equal(outcome.totalCostUsd, null);
		assert.equal(outcome.sessionId, 's-1');
	});
});

describe('resolveChatOutcome — the structured-output passthrough (R16)', () => {
	it('a format_final_json_response call returns as a tool call under its ORIGINAL name', () => {
		const outcome = resolveChatOutcome([
			init,
			formatCall({ city: 'Lisbon', temp: 21 }, 'tu-1'),
			success(),
		]);
		assert.deepEqual(outcome.toolCalls, [
			{ id: 'tu-1', name: 'format_final_json_response', args: { city: 'Lisbon', temp: 21 } },
		]);
	});

	it('the LAST call wins — a self-correction supersedes the first attempt', () => {
		const outcome = resolveChatOutcome([
			init,
			formatCall({ v: 1 }, 'tu-1'),
			formatCall({ v: 2 }, 'tu-2'),
			success(),
		]);
		assert.equal(outcome.toolCalls.length, 1);
		assert.deepEqual(outcome.toolCalls[0].args, { v: 2 });
		assert.equal(outcome.toolCalls[0].id, 'tu-2');
	});

	it('other tool calls are NOT passed through — the bridge executed them already', () => {
		const other = msg({
			type: 'assistant',
			session_id: 's-1',
			message: {
				content: [{ type: 'tool_use', name: 'mcp__n8n__calculator', id: 'tu-9', input: {} }],
			},
		});
		const outcome = resolveChatOutcome([init, other, assistantText('done'), success()]);
		assert.deepEqual(outcome.toolCalls, []);
	});
});
