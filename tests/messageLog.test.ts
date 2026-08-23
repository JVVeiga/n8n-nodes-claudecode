import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from 'n8n-workflow';
import { logMessage } from '../nodes/ClaudeCode/messageLog';
import { createDebugLogger } from '../nodes/shared/debug';
import {
	assistantText,
	assistantThinking,
	assistantTool,
	errorResult,
	init,
	msg,
	successResult,
	userToolResult,
} from './helpers/sdkMessages';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * The per-message debug logging.
 *
 * Worth its own tests for one reason: it is the code someone reads a production incident through.
 * If it silently logs nothing for a message type, or throws on a shape it did not expect, the
 * person debugging loses the only view they have — and it runs on every message of every run.
 */

const spy = () => {
	const calls: Array<{ level: string; message: string; meta?: unknown }> = [];
	const logger = {
		debug: (message: string, meta?: unknown) => calls.push({ level: 'debug', message, meta }),
		info: () => {},
		warn: () => {},
		error: (message: string, meta?: unknown) => calls.push({ level: 'error', message, meta }),
	} as unknown as Logger;
	return { calls, logger };
};

const log = (message: SDKMessage, enabled = true) => {
	const { calls, logger } = spy();
	logMessage(createDebugLogger(logger, enabled), message);
	return calls;
};

describe('logMessage — gating', () => {
	it('does nothing at all when debug is off', () => {
		assert.deepEqual(log(successResult(), false), []);
	});
});

describe('logMessage — per message type', () => {
	it('reports an init message with the resolved model and tool count', () => {
		const calls = log(init({ model: 'claude-opus-5', tools: ['Bash', 'Read'] }));
		assert.equal(calls[0].message, 'System init message');
		assert.deepEqual(calls[0].meta, {
			type: 'system',
			subtype: 'init',
			model: 'claude-opus-5',
			toolCount: 2,
		});
	});

	it('reports an assistant text turn, and previews the text', () => {
		const calls = log(assistantText('the answer'));
		assert.deepEqual(calls[0].meta, {
			type: 'assistant',
			contentTypes: ['text'],
			textLength: 10,
			hasToolUse: false,
		});
		assert.equal(calls[1].message, 'Assistant response');
		assert.match(String((calls[1].meta as { text: string }).text), /^the answer/);
	});

	it('reports a tool call by name', () => {
		const calls = log(assistantTool('Bash'));
		assert.equal((calls[0].meta as { hasToolUse: boolean }).hasToolUse, true);
		assert.equal(calls[1].message, 'Tool use');
		assert.deepEqual(calls[1].meta, { toolName: 'Bash' });
	});

	it('reports a thinking turn without previewing anything', () => {
		const calls = log(assistantThinking());
		assert.deepEqual((calls[0].meta as { contentTypes: string[] }).contentTypes, ['thinking']);
		// The first block is neither text nor tool_use, so no second line.
		assert.equal(calls.length, 1);
	});

	it('reports whether a user turn carried a tool result', () => {
		assert.equal((log(userToolResult())[0].meta as { hasToolResult: boolean }).hasToolResult, true);
		assert.equal(
			(
				log(msg({ type: 'user', message: { content: 'plain text' } }))[0].meta as {
					hasToolResult: boolean;
				}
			).hasToolResult,
			false,
		);
	});

	it('reports a result message with its spend', () => {
		const calls = log(successResult());
		assert.equal(calls[0].message, 'Result message');
		const meta = calls[0].meta as Record<string, unknown>;
		assert.equal(meta.subtype, 'success');
		assert.equal(meta.hasResult, true);
		assert.equal(meta.total_cost, 0.0412);
		assert.equal(meta.error, 'none');
	});

	it('escalates error_during_execution to error level — that one is a real failure', () => {
		// Every other line is a diagnostic worth ignoring. This one usually is not.
		const calls = log(errorResult('error_during_execution'));
		const escalated = calls.find((c) => c.level === 'error');
		assert.ok(escalated, 'must not be buried at debug level');
		assert.equal(escalated.message, 'Claude Code execution error');
		assert.match(String((escalated.meta as { error: string }).error), /error_during_execution/);
	});

	it('does not escalate the other error subtypes', () => {
		for (const subtype of ['error_max_turns', 'error_max_budget_usd'] as const) {
			assert.equal(
				log(errorResult(subtype)).some((c) => c.level === 'error'),
				false,
				subtype,
			);
		}
	});

	it('falls back to a generic line for a type it does not know', () => {
		const calls = log(msg({ type: 'something_new', payload: 1 }));
		assert.equal(calls[0].message, 'Other message');
		assert.equal((calls[0].meta as { type: string }).type, 'something_new');
	});

	it('treats a non-init system message as unknown rather than mislabelling it', () => {
		const calls = log(msg({ type: 'system', subtype: 'compact_boundary' }));
		assert.equal(calls[0].message, 'Other message');
	});
});

describe('logMessage — malformed messages must not break a run', () => {
	// This runs on every message of every run. Throwing here would take down a run that was
	// otherwise fine, purely to write a log line.
	const malformed: Array<[string, object]> = [
		['no content at all', { type: 'assistant' }],
		['content is not an array', { type: 'assistant', message: { content: 'oops' } }],
		['empty content array', { type: 'assistant', message: { content: [] } }],
		['a text block with no text', { type: 'assistant', message: { content: [{ type: 'text' }] } }],
		[
			'a tool_use with no name',
			{ type: 'assistant', message: { content: [{ type: 'tool_use' }] } },
		],
		['a result with no fields', { type: 'result' }],
		['an init with no tools', { type: 'system', subtype: 'init' }],
		['a user turn with no message', { type: 'user' }],
		['no type at all', {}],
	];

	for (const [label, shape] of malformed) {
		it(`survives ${label}`, () => {
			assert.doesNotThrow(() => log(msg(shape)));
		});
	}

	it('truncates a huge payload rather than logging all of it', () => {
		const calls = log(msg({ type: 'weird', blob: 'x'.repeat(5000) }));
		assert.ok(String((calls[0].meta as { message: string }).message).length <= 200);
	});

	it('truncates a long assistant preview', () => {
		const calls = log(assistantText('y'.repeat(500)));
		const preview = String((calls[1].meta as { text: string }).text);
		assert.ok(preview.length < 120, 'a 500-char turn must not fill the log');
		assert.match(preview, /\.\.\.$/);
	});
});
