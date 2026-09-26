import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
	resumeFoundNothing,
	runWithSession,
	toSessionUuid,
	type SessionAttempt,
	type SessionRequest,
} from '../nodes/shared/session';
import { assistantText, init, msg } from './helpers/sdkMessages';

describe('toSessionUuid — pinned values', () => {
	// Computed before the function moved: a changed value would orphan every stored conversation.
	const pinned: Array<[string, string]> = [
		['discord:846311', '3d7f9e15-8fc2-5292-90d8-6d9547fc49a0'],
		['gh:acme/api#9514', 'afb46282-23a9-512f-8d8a-26e686ec59a3'],
		['+5511999990000', '1e869c7c-e920-58c8-85ae-d5812ad9febd'],
		['ticket-42', '42776d38-610a-54aa-8ab4-6c464f5027f8'],
		['', '693a4778-a499-5a11-9d23-93ba3b69de15'],
		['3F2504E0-4F89-11D3-9A0C-0305E82C3301', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
	];
	for (const [key, uuid] of pinned) {
		it(`${JSON.stringify(key)} -> ${uuid}`, () => {
			assert.equal(toSessionUuid(key), uuid);
		});
	}
});

const ok = (): SessionAttempt => ({
	run: { error: null, timedOut: false },
	sdkMessages: [
		init(),
		assistantText('pong'),
		msg({ type: 'result', subtype: 'success', num_turns: 1, result: 'pong' }),
	],
});

const silentNotFound = (): SessionAttempt => ({
	run: { error: null, timedOut: false },
	sdkMessages: [init(), msg({ type: 'result', subtype: 'error_during_execution', num_turns: 0 })],
});

const rejectedNotFound = (): SessionAttempt => ({
	run: { error: new Error('No conversation found with session ID: abc'), timedOut: false },
	sdkMessages: [init(), msg({ type: 'result', subtype: 'error_during_execution' })],
});

type Call = { session: SessionRequest; timeoutSeconds: number };

const recorder = (attempts: SessionAttempt[], onRun?: () => void) => {
	const calls: Call[] = [];
	const runOnce = async (session: SessionRequest, budget: { timeoutSeconds: number }) => {
		calls.push({ session, timeoutSeconds: budget.timeoutSeconds });
		onRun?.();
		return attempts[calls.length - 1];
	};
	return { calls, runOnce };
};

describe('resumeFoundNothing', () => {
	it('recognises both not-found shapes', () => {
		assert.equal(resumeFoundNothing(silentNotFound()), true);
		assert.equal(resumeFoundNothing(rejectedNotFound()), true);
	});

	it('a timeout, another error, or an early failure with turns is not a missing session', () => {
		assert.equal(
			resumeFoundNothing({ ...rejectedNotFound(), run: { error: null, timedOut: true } }),
			false,
		);
		assert.equal(
			resumeFoundNothing({ run: { error: new Error('401'), timedOut: false }, sdkMessages: [] }),
			false,
		);
		const withTurns: SDKMessage[] = [
			msg({ type: 'result', subtype: 'error_during_execution', num_turns: 2 }),
		];
		assert.equal(
			resumeFoundNothing({ run: { error: null, timedOut: false }, sdkMessages: withTurns }),
			false,
		);
		assert.equal(resumeFoundNothing(ok()), false);
	});
});

describe('runWithSession', () => {
	it('no session id: one anonymous run, state new', async () => {
		const { calls, runOnce } = recorder([silentNotFound()]);
		const result = await runWithSession(runOnce, { sessionUuid: null, timeoutSeconds: 60 });
		assert.deepEqual(calls, [{ session: null, timeoutSeconds: 60 }]);
		assert.equal(result.state, 'new');
		assert.equal(result.unrecoverable, false);
	});

	it('resume found: one run, state resumed', async () => {
		const { calls, runOnce } = recorder([ok()]);
		const result = await runWithSession(runOnce, { sessionUuid: 'u-1', timeoutSeconds: 60 });
		assert.deepEqual(calls, [{ session: { resume: 'u-1' }, timeoutSeconds: 60 }]);
		assert.equal(result.state, 'resumed');
		assert.equal(result.unrecoverable, false);
	});

	it('not found via the result shape: created under the same id', async () => {
		const created = ok();
		const { calls, runOnce } = recorder([silentNotFound(), created]);
		const result = await runWithSession(runOnce, { sessionUuid: 'u-1', timeoutSeconds: 60 });
		assert.deepEqual(
			calls.map((call) => call.session),
			[{ resume: 'u-1' }, { create: 'u-1' }],
		);
		assert.equal(result.state, 'created');
		assert.equal(result.attempt, created);
		assert.equal(result.unrecoverable, false);
	});

	it('not found via the rejection: created under the same id', async () => {
		const { calls, runOnce } = recorder([rejectedNotFound(), ok()]);
		const result = await runWithSession(runOnce, { sessionUuid: 'u-1', timeoutSeconds: 60 });
		assert.deepEqual(calls[1].session, { create: 'u-1' });
		assert.equal(result.state, 'created');
		assert.equal(result.unrecoverable, false);
	});

	it('create also finds nothing: unrecoverable, and no third attempt', async () => {
		const { calls, runOnce } = recorder([silentNotFound(), rejectedNotFound()]);
		const result = await runWithSession(runOnce, { sessionUuid: 'u-1', timeoutSeconds: 60 });
		assert.equal(calls.length, 2);
		assert.equal(result.state, 'created');
		assert.equal(result.unrecoverable, true);
	});

	it('the create attempt gets what is left of one budget, floored at 5s', async () => {
		let clock = 1_000_000;
		const { calls, runOnce } = recorder([silentNotFound(), ok()], () => {
			clock += 42_700;
		});
		await runWithSession(runOnce, {
			sessionUuid: 'u-1',
			timeoutSeconds: 60,
			startedAt: clock,
			now: () => clock,
		});
		assert.deepEqual(
			calls.map((call) => call.timeoutSeconds),
			[60, 18],
			'60 − floor(42.7)',
		);

		clock = 0;
		const late = recorder([silentNotFound(), ok()], () => {
			clock += 59_000;
		});
		await runWithSession(late.runOnce, {
			sessionUuid: 'u-1',
			timeoutSeconds: 60,
			startedAt: 0,
			now: () => clock,
		});
		assert.deepEqual(
			late.calls.map((call) => call.timeoutSeconds),
			[60, 5],
		);
	});
});
