import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runQuery, WRAP_UP_PROMPT, type RunInput } from '../nodes/ClaudeCode/runner';
import { createPromptStream } from '../nodes/ClaudeCode/promptStream';
import { resolveGraceWindow } from '../nodes/ClaudeCode/timeout';
import { createDebugLogger } from '../nodes/shared/debug';
import type { QueryOptions } from '../nodes/ClaudeCode/types';
import { createFakeQuery } from './helpers/fakeQuery';
import {
	assistantText,
	assistantTool,
	init,
	successResult,
	wrapUpResult,
} from './helpers/sdkMessages';

/**
 * The timeout choreography, which is the subtlest thing in the node.
 *
 * No fake timers (DEC-06 — bare node:test, no extra deps), so the timeouts are real but tiny:
 * a hang plus a sub-second grace window. The fake query controls when the stream yields, which is
 * what makes these deterministic rather than racy.
 */

const silent = createDebugLogger({ debug() {}, info() {}, warn() {}, error() {} } as never, false);

type RunOpts = {
	messages?: SDKMessage[];
	afterInterrupt?: SDKMessage[];
	hang?: boolean;
	interruptThrows?: boolean;
	throwAfter?: Error;
	/** Seconds. Kept small — these are real timers. */
	timeout?: number;
	grace?: number;
	appliedEffort?: string;
};

async function run(opts: RunOpts) {
	const abortController = new AbortController();
	const { fake, record } = createFakeQuery({
		messages: opts.messages ?? [],
		afterInterrupt: opts.afterInterrupt,
		hang: opts.hang,
		interruptThrows: opts.interruptThrows,
		throwAfter: opts.throwAfter,
		// A hanging stream has to end when the hard timer aborts, exactly as the SDK's would.
		abortSignal: abortController.signal,
	});
	const promptStream = createPromptStream('go');
	const messages: SDKMessage[] = [];
	const input: RunInput = {
		queryOptions: { prompt: promptStream.stream, options: {} } as QueryOptions,
		graceWindow: resolveGraceWindow(opts.timeout ?? 1, opts.grace ?? 0),
		promptStream,
		abortController,
		query: fake,
		debug: silent,
		messages,
		getAppliedEffort: () => opts.appliedEffort,
	};
	const outcome = await runQuery(input);
	return { outcome, record, abortController, promptStream };
}

describe('runQuery — a run that finishes on its own', () => {
	it('collects the messages and reports no timeout', async () => {
		const { outcome } = await run({ messages: [init(), assistantText('pong'), successResult()] });
		assert.equal(outcome.timedOut, false);
		assert.equal(outcome.terminationReason, null);
		assert.equal(outcome.error, null);
		assert.equal(outcome.messages.length, 3);
	});

	it('pushes into the array the caller holds, so an error path can read it', async () => {
		const messages: SDKMessage[] = [];
		const { fake } = createFakeQuery({ messages: [init(), successResult()] });
		const promptStream = createPromptStream('go');
		await runQuery({
			queryOptions: { prompt: promptStream.stream, options: {} } as QueryOptions,
			graceWindow: resolveGraceWindow(1, 0),
			promptStream,
			abortController: new AbortController(),
			query: fake,
			debug: silent,
			messages,
		});
		assert.equal(messages.length, 2, 'the caller sees the messages without the return value');
	});

	it('reports the applied effort through the getter', async () => {
		const { outcome } = await run({ messages: [init()], appliedEffort: 'xhigh' });
		assert.equal(outcome.appliedEffort, 'xhigh');
	});

	it('reports null applied effort when no hook fired', async () => {
		const { outcome } = await run({ messages: [init()] });
		assert.equal(outcome.appliedEffort, null);
	});

	it('measures a duration', async () => {
		const { outcome } = await run({ messages: [init()] });
		assert.ok(outcome.durationMs >= 0);
	});

	it('closes the input stream on the result message — otherwise the query never ends', async () => {
		const { promptStream } = await run({ messages: [init(), successResult()] });
		// The generator yields the initial prompt first, then finishes because it was closed. An
		// unclosed stream would block on its wake promise here instead of reporting done.
		const iterator = promptStream.stream[Symbol.asyncIterator]();
		assert.equal((await iterator.next()).done, false, 'the initial prompt');
		assert.equal((await iterator.next()).done, true, 'then closed');
	});
});

describe('runQuery — graceful timeout', () => {
	it('interrupts, sends the wrap-up prompt, and reports a graceful stop', async () => {
		const { outcome, record } = await run({
			hang: true,
			messages: [init(), assistantTool('Read')],
			afterInterrupt: [successResult(), wrapUpResult],
			timeout: 2,
			grace: 1,
		});
		assert.equal(outcome.timedOut, true);
		assert.equal(outcome.terminationReason, 'timeout_graceful');
		assert.equal(record.interruptCount, 1, 'interrupt is what makes the SDK account for the run');
	});

	it('reports wrapUpSucceeded when the SECOND result arrives', async () => {
		// The first result after an interrupt is the interrupt's own; the second is the summary.
		const { outcome } = await run({
			hang: true,
			messages: [init()],
			afterInterrupt: [successResult(), wrapUpResult],
			timeout: 2,
			grace: 1,
		});
		assert.equal(outcome.wrapUpSucceeded, true);
		assert.ok(outcome.messages.filter((m) => m.type === 'result').length >= 2);
	});

	it('reports wrapUpSucceeded false when the wrap-up itself never finishes', async () => {
		// Only the interrupt's own result arrives. The metrics survive; the summary does not.
		const { outcome } = await run({
			hang: true,
			messages: [init(), assistantTool('Read')],
			afterInterrupt: [successResult()],
			timeout: 2,
			grace: 1,
		});
		assert.equal(outcome.timedOut, true);
		assert.equal(outcome.wrapUpSucceeded, false);
		assert.equal(outcome.terminationReason, 'timeout_graceful');
	});

	it('sends the wrap-up as a normal user turn asking for a handover, not more work', () => {
		assert.match(WRAP_UP_PROMPT, /Stop all work now/);
		assert.match(WRAP_UP_PROMPT, /do not edit files/);
		assert.match(WRAP_UP_PROMPT, /exact next steps to resume/);
	});

	it('swallows an interrupt that throws — the hard timer is the backstop', async () => {
		const { outcome, abortController } = await run({
			hang: true,
			messages: [init()],
			interruptThrows: true,
			timeout: 2,
			grace: 1,
		});
		assert.equal(outcome.timedOut, true);
		assert.equal(abortController.signal.aborted, true, 'the hard timer still fired');
	});
});

describe('runQuery — hard abort', () => {
	it('aborts with no wrap-up when the grace is zero', async () => {
		const { outcome, record, abortController } = await run({
			hang: true,
			messages: [init(), assistantTool('Read')],
			timeout: 1,
			grace: 0,
		});
		assert.equal(outcome.timedOut, true);
		assert.equal(outcome.terminationReason, 'timeout_hard_abort');
		assert.equal(record.interruptCount, 0, 'no interrupt without a grace window');
		assert.equal(abortController.signal.aborted, true);
	});

	it('keeps whatever messages arrived before the abort', async () => {
		const { outcome } = await run({
			hang: true,
			messages: [init(), assistantTool('Read'), assistantText('partial')],
			timeout: 1,
			grace: 0,
		});
		assert.equal(outcome.messages.length, 3);
	});
});

describe('runQuery — the wrap-up timer bails out on a finished run', () => {
	it('does not report a timeout when a result already arrived', async () => {
		// The SDK emits no result message until a turn ends, so one already present means there is
		// nothing left to interrupt. Billing a wrap-up turn here would report a completed run as a
		// timeout — the bug this guard exists for.
		const { outcome, record } = await run({
			messages: [init(), assistantText('pong'), successResult()],
			timeout: 2,
			grace: 1,
		});
		assert.equal(outcome.timedOut, false, 'a completed run must not be reported as a timeout');
		assert.equal(record.interruptCount, 0, 'and must not be billed for a wrap-up turn');
		assert.equal(outcome.terminationReason, null);
	});

	it('a run finishing inside the grace window is still a success', async () => {
		const { outcome } = await run({
			messages: [init(), successResult()],
			timeout: 2,
			grace: 1,
		});
		assert.equal(outcome.timedOut, false);
		assert.equal(outcome.error, null);
	});
});

describe('runQuery — a generator that rejects', () => {
	it('reports the error rather than throwing it', async () => {
		const boom = new Error('SDK exploded');
		const { outcome } = await run({ messages: [init(), successResult()], throwAfter: boom });
		assert.equal(outcome.error, boom);
		assert.equal(outcome.timedOut, false);
	});

	it('keeps the messages that arrived before the rejection — a failed run still cost money', async () => {
		const { outcome } = await run({
			messages: [init(), assistantText('work'), successResult()],
			throwAfter: new Error('boom'),
		});
		assert.equal(outcome.messages.length, 3);
	});

	it('still closes the input stream, releasing the suspended generator', async () => {
		// On an error path the loop stops consuming while the generator is suspended waiting for a
		// follow-up turn. runQuery's finally closes it; without that this would hang.
		const { promptStream } = await run({
			messages: [init()],
			throwAfter: new Error('boom'),
		});
		const iterator = promptStream.stream[Symbol.asyncIterator]();
		assert.equal((await iterator.next()).done, false, 'the initial prompt');
		assert.equal((await iterator.next()).done, true, 'then closed');
	});
});

describe('runQuery — the query call', () => {
	it('passes the options straight through', async () => {
		const promptStream = createPromptStream('go');
		const options = { maxTurns: 7 };
		const { fake, record } = createFakeQuery({ messages: [init()] });
		await runQuery({
			queryOptions: { prompt: promptStream.stream, options } as unknown as QueryOptions,
			graceWindow: resolveGraceWindow(1, 0),
			promptStream,
			abortController: new AbortController(),
			query: fake,
			debug: silent,
			messages: [],
		});
		assert.equal(record.calls.length, 1);
		assert.equal((record.calls[0] as { options: typeof options }).options, options);
	});
});
