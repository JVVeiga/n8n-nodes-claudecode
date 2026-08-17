import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
	buildTimeoutPayload,
	collectRunMetrics,
	formatTimeoutDescription,
	formatTimeoutMessage,
	resolveGraceWindow,
	type RunMetrics,
	type TimeoutPayloadInput,
} from '../nodes/ClaudeCode/timeout';

const SESSION = '1e76098f-2bf5-424d-9694-d1feab1cfc12';

/** SDK message types carry many required fields that are irrelevant here. Fixtures stay readable
 * by asserting the shape rather than spelling out every field. */
const msg = (shape: object): SDKMessage => shape as unknown as SDKMessage;

const init = (sessionId = SESSION) =>
	msg({
		type: 'system',
		subtype: 'init',
		model: 'claude-sonnet-5',
		tools: [],
		session_id: sessionId,
	});

const assistantText = (text: string) =>
	msg({ type: 'assistant', message: { content: [{ type: 'text', text }] }, session_id: SESSION });

const assistantTool = (name: string, usageOutputTokens = 3) =>
	msg({
		type: 'assistant',
		message: {
			content: [{ type: 'tool_use', name, input: {} }],
			// Placeholder values — the real SDK reports these per message and they do NOT add up to
			// the session total. Present here specifically so a test can prove we ignore them.
			usage: { input_tokens: 2, output_tokens: usageOutputTokens, cache_read_input_tokens: 10 },
		},
		session_id: SESSION,
	});

const model = (over: Partial<Record<string, number>> = {}) => ({
	inputTokens: 4,
	outputTokens: 486,
	cacheReadInputTokens: 65361,
	cacheCreationInputTokens: 23578,
	webSearchRequests: 0,
	costUSD: 0.16837829999999998,
	contextWindow: 1000000,
	maxOutputTokens: 64000,
	...over,
});

/** The interrupt's own result, values taken from a real run. Per-turn counts, no text. */
const interruptResult = msg({
	type: 'result',
	subtype: 'error_during_execution',
	num_turns: 5,
	total_cost_usd: 0.16837829999999998,
	usage: { input_tokens: 4, output_tokens: 486 },
	modelUsage: { 'claude-sonnet-5': model() },
	stop_reason: 'tool_use',
	terminal_reason: 'aborted_tools',
	is_error: true,
	errors: ['[ede_diagnostic] result_type=user'],
	session_id: SESSION,
});

const WRAP_UP_TEXT =
	'- Read `claudecode.svg`.\n- Left: describe `ClaudeCode.node.ts`.\n- Next: read it.';

/** The wrap-up turn's result. Note num_turns restarts at 1 while modelUsage is cumulative. */
const wrapUpResult = msg({
	type: 'result',
	subtype: 'success',
	num_turns: 1,
	total_cost_usd: 0.21266249999999998,
	usage: { input_tokens: 2, output_tokens: 133 },
	modelUsage: {
		'claude-sonnet-5': model({
			inputTokens: 6,
			outputTokens: 619,
			cacheReadInputTokens: 110085,
			cacheCreationInputTokens: 28389,
			costUSD: 0.21266249999999998,
		}),
	},
	stop_reason: 'end_turn',
	terminal_reason: 'completed',
	is_error: false,
	result: WRAP_UP_TEXT,
	session_id: SESSION,
});

const payloadInput = (metrics: RunMetrics, over: Partial<TimeoutPayloadInput> = {}) =>
	({
		metrics,
		terminationReason: 'timeout_graceful',
		timeoutSeconds: 900,
		graceSeconds: 60,
		wrapUpSucceeded: true,
		durationMs: 899412,
		messageCount: 812,
		diagnostics: { resolvedModel: 'claude-sonnet-5' },
		...over,
	}) satisfies TimeoutPayloadInput;

describe('collectRunMetrics — graceful timeout (two result messages)', () => {
	const metrics = collectRunMetrics([
		init(),
		assistantTool('Read'),
		interruptResult,
		init(),
		assistantText(WRAP_UP_TEXT),
		wrapUpResult,
	]);

	it('reads cost from the last result, which is cumulative', () => {
		assert.equal(metrics.totalCostUsd, 0.21266249999999998);
	});

	it('sums num_turns across every result, because each reports only its own turn', () => {
		assert.equal(metrics.numTurns, 6);
	});

	it('takes token totals from the cumulative modelUsage, not the per-turn usage', () => {
		assert.deepEqual(metrics.usage, {
			inputTokens: 6,
			outputTokens: 619,
			cacheReadInputTokens: 110085,
			cacheCreationInputTokens: 28389,
		});
	});

	it('marks the usage as reliable', () => {
		assert.equal(metrics.usageReliable, true);
	});

	it('prefers the wrap-up text over the interrupt result, which has no text', () => {
		assert.equal(metrics.resultText, WRAP_UP_TEXT);
		assert.equal(metrics.resultTextSource, 'result');
	});

	it('reports the session id', () => {
		assert.equal(metrics.sessionId, SESSION);
	});
});

describe('collectRunMetrics — hard abort (no result message)', () => {
	it('reports every spend field as null rather than a fabricated number', () => {
		const metrics = collectRunMetrics([init(), assistantTool('Bash'), assistantTool('Read')]);

		assert.equal(metrics.usage, null);
		assert.equal(metrics.usageReliable, false);
		assert.equal(metrics.totalCostUsd, null);
		assert.equal(metrics.numTurns, null);
		assert.equal(metrics.modelUsage, null);
	});

	it('still reports what it can observe', () => {
		const metrics = collectRunMetrics([init(), assistantTool('Bash'), assistantTool('Read')]);

		assert.equal(metrics.assistantTurns, 2);
		assert.equal(metrics.toolUseCount, 2);
		assert.deepEqual(
			metrics.toolTimeline.map((t) => t.name),
			['Bash', 'Read'],
		);
	});

	it('falls back to the last assistant text', () => {
		const metrics = collectRunMetrics([init(), assistantText('first'), assistantText('second')]);

		assert.equal(metrics.resultText, 'second');
		assert.equal(metrics.resultTextSource, 'assistant');
	});

	it('falls back to the init message for the session id', () => {
		const metrics = collectRunMetrics([init('abc-123'), assistantTool('Read')]);

		assert.equal(metrics.sessionId, 'abc-123');
	});
});

describe('collectRunMetrics — degenerate input', () => {
	it('does not throw on an empty stream', () => {
		const metrics = collectRunMetrics([]);

		assert.equal(metrics.usage, null);
		assert.equal(metrics.usageReliable, false);
		assert.equal(metrics.numTurns, null);
		assert.equal(metrics.sessionId, null);
		assert.equal(metrics.resultText, null);
		assert.equal(metrics.resultTextSource, null);
		assert.deepEqual(metrics.toolTimeline, []);
	});

	it('treats a result with no modelUsage as unreliable rather than guessing', () => {
		const metrics = collectRunMetrics([
			init(),
			msg({
				type: 'result',
				subtype: 'success',
				num_turns: 3,
				result: 'done',
				session_id: SESSION,
			}),
		]);

		assert.equal(metrics.usage, null);
		assert.equal(metrics.usageReliable, false);
		assert.equal(metrics.totalCostUsd, null);
		// The text is still usable even when the accounting is missing.
		assert.equal(metrics.resultText, 'done');
	});

	it('ignores per-message assistant usage even when it contradicts modelUsage', () => {
		// Twenty tool calls each claiming 999 output tokens. Summing them would report 19980;
		// modelUsage says 619. The SDK's own accounting wins.
		const noisy = Array.from({ length: 20 }, () => assistantTool('Read', 999));
		const metrics = collectRunMetrics([init(), ...noisy, interruptResult, wrapUpResult]);

		assert.equal(metrics.usage?.outputTokens, 619);
	});
});

describe('collectRunMetrics — tool timeline cap', () => {
	it('keeps the last 100 of 531 tool uses and flags the truncation', () => {
		const many = Array.from({ length: 531 }, (_, i) => assistantTool(`Tool${i}`));
		const metrics = collectRunMetrics([init(), ...many]);

		assert.equal(metrics.toolUseCount, 531);
		assert.equal(metrics.toolTimeline.length, 100);
		assert.equal(metrics.toolTimelineTruncated, true);
		// The tail is kept: the last entry is the 531st tool use, at index 530.
		assert.equal(metrics.toolTimeline[99].name, 'Tool530');
		assert.equal(metrics.toolTimeline[99].index, 530);
		assert.equal(metrics.toolTimeline[0].index, 431);
	});

	it('does not truncate a short timeline', () => {
		const few = Array.from({ length: 12 }, (_, i) => assistantTool(`Tool${i}`));
		const metrics = collectRunMetrics([init(), ...few]);

		assert.equal(metrics.toolUseCount, 12);
		assert.equal(metrics.toolTimeline.length, 12);
		assert.equal(metrics.toolTimelineTruncated, false);
	});
});

describe('resolveGraceWindow', () => {
	it('carves the grace out of the timeout', () => {
		assert.deepEqual(resolveGraceWindow(900, 60), {
			wrapUpAtMs: 840_000,
			hardAbortAtMs: 900_000,
			graceSeconds: 60,
		});
	});

	it('clamps the grace to half the timeout', () => {
		assert.deepEqual(resolveGraceWindow(60, 600), {
			wrapUpAtMs: 30_000,
			hardAbortAtMs: 60_000,
			graceSeconds: 30,
		});
	});

	it('arms no wrap-up when the grace is zero', () => {
		assert.deepEqual(resolveGraceWindow(900, 0), {
			wrapUpAtMs: null,
			hardAbortAtMs: 900_000,
			graceSeconds: 0,
		});
	});

	it('treats a negative grace as zero', () => {
		assert.equal(resolveGraceWindow(900, -30).wrapUpAtMs, null);
		assert.equal(resolveGraceWindow(900, -30).graceSeconds, 0);
	});
});

describe('buildTimeoutPayload', () => {
	const metrics = collectRunMetrics([init(), assistantTool('Read'), interruptResult, wrapUpResult]);
	const payload = buildTimeoutPayload(payloadInput(metrics));

	it('marks the failure unmistakably as a timeout', () => {
		assert.equal(payload.errorType, 'timeout');
		assert.equal(payload.timedOut, true);
		assert.equal(payload.terminationReason, 'timeout_graceful');
	});

	it('keeps json.error a plain message string, per n8n convention', () => {
		assert.equal(typeof payload.error, 'string');
		assert.match(payload.error as string, /timed out/);
	});

	it('returns the metrics as flat fields', () => {
		assert.equal(payload.total_cost_usd, 0.21266249999999998);
		assert.equal(payload.num_turns, 6);
		assert.equal(payload.session_id, SESSION);
		assert.equal(payload.usageReliable, true);
		assert.equal(payload.resultSource, 'wrap_up');
		assert.deepEqual(payload.diagnostics, { resolvedModel: 'claude-sonnet-5' });
	});

	it('maps an assistant-text fallback to last_assistant_text', () => {
		const bare = collectRunMetrics([init(), assistantText('partial work')]);
		const hardAbort = buildTimeoutPayload(
			payloadInput(bare, { terminationReason: 'timeout_hard_abort', wrapUpSucceeded: false }),
		);

		assert.equal(hardAbort.resultSource, 'last_assistant_text');
		assert.equal(hardAbort.result, 'partial work');
		assert.equal(hardAbort.total_cost_usd, null);
		assert.equal(hardAbort.usageReliable, false);
	});
});

describe('formatTimeoutMessage', () => {
	it('is a single self-describing line with the headline numbers', () => {
		const metrics = collectRunMetrics([init(), interruptResult, wrapUpResult]);
		const message = formatTimeoutMessage(payloadInput(metrics));

		assert.ok(!message.includes('\n'), 'must be one line');
		assert.match(message, /timed out after 900s/);
		assert.match(message, /wrap-up summary returned/);
		assert.match(message, /6 turns/);
		assert.match(message, /\$0\.2127 spent/);
		assert.match(message, new RegExp(SESSION));
	});

	it('says the cost is unknown rather than printing $0', () => {
		const metrics = collectRunMetrics([init(), assistantTool('Read')]);
		const message = formatTimeoutMessage(
			payloadInput(metrics, { terminationReason: 'timeout_hard_abort', wrapUpSucceeded: false }),
		);

		assert.match(message, /cost unknown/);
		assert.ok(!message.includes('$0'), 'must not imply a free run');
		assert.match(message, /process aborted, no summary/);
	});

	it('reports a wrap-up that did not finish', () => {
		const metrics = collectRunMetrics([init(), interruptResult]);
		const message = formatTimeoutMessage(payloadInput(metrics, { wrapUpSucceeded: false }));

		assert.match(message, /wrap-up did not finish/);
		// The interrupt's result still landed, so the spend is known.
		assert.match(message, /\$0\.1684 spent/);
	});
});

describe('formatTimeoutDescription', () => {
	it('breaks the tokens down and explains how to resume', () => {
		const metrics = collectRunMetrics([init(), interruptResult, wrapUpResult]);
		const description = formatTimeoutDescription(payloadInput(metrics));

		assert.match(description, /Grace window: 60s/);
		assert.match(description, /619 out/);
		assert.match(description, /claude-sonnet-5/);
		assert.match(
			description,
			new RegExp(`Resume with the Continue operation and session id ${SESSION}`),
		);
	});

	it('explains why the tokens are missing on a hard abort', () => {
		const metrics = collectRunMetrics([init(), assistantTool('Read')]);
		const description = formatTimeoutDescription(
			payloadInput(metrics, { terminationReason: 'timeout_hard_abort', graceSeconds: 0 }),
		);

		assert.match(description, /Token counts are unavailable/);
		assert.match(description, /Tools used: 1/);
	});
});
