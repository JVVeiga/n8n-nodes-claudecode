import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escalateUsageRead } from '../nodes/ClaudeCodeUsage/escalate';
import { PROFILE_SCOPES, PROBE_PROMPT, type readUsage } from '../nodes/ClaudeCodeUsage/readUsage';

/**
 * The three-step read, now shared by the Usage node and the Usage tool. It escalates only when
 * it must: the scope retry is free, the probe costs real money. A recorder rather than a stub
 * that ignores its arguments — what matters here is exactly WHICH calls were made.
 */

/** A payload that reports a token session with no windows: the shape that triggers the retry. */
const REFUSED = {
	// `tokenSource` lives under init.account — normalizeAccount reads it from there, and a
	// fixture that puts it at the root looks authenticated but reports no token source, so the
	// retry predicate never fires. Measured while writing this test.
	init: { account: { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' } },
	usage: {},
	claudeCodeVersion: '2.1.251',
	initMs: 1,
	usageMs: 1,
	unsupported: false,
	probeCostUsd: null,
};

/**
 * A payload the CLI DID answer with plan data: `rate_limits_available` is the server's own flag
 * and the only thing `planLimitsApply` reads, so this is what tells the escalation to stop.
 */
const WITH_WINDOWS = {
	...REFUSED,
	usage: {
		rate_limits_available: true,
		rate_limits: {
			five_hour: { utilization: 40, resets_at: '2026-09-01T03:00:00+00:00' },
		},
	},
};

const recorder = (responses: Array<Record<string, unknown>>) => {
	const calls: Array<Record<string, unknown>> = [];
	const read = (async (options: Record<string, unknown>) => {
		calls.push(options);
		return responses[Math.min(calls.length - 1, responses.length - 1)];
	}) as unknown as typeof readUsage;
	return { calls, read };
};

const base = { timeoutMs: 1000 };

describe('escalateUsageRead', () => {
	it('a read the CLI already answered with plan data stops at one call', async () => {
		const { calls, read } = recorder([WITH_WINDOWS]);
		const result = await escalateUsageRead(read, base, {
			declareProfileScope: true,
			probeIfUnavailable: true,
		});
		assert.equal(calls.length, 1);
		assert.equal(result.scopeRetried, false);
	});

	it('declareProfileScope: false suppresses the retry even when windows are missing', async () => {
		const { calls, read } = recorder([REFUSED]);
		const result = await escalateUsageRead(read, base, {
			declareProfileScope: false,
			probeIfUnavailable: true,
		});
		assert.equal(calls.length, 1, 'the user opted out of the retry');
		assert.equal(result.scopeRetried, false);
	});

	it('a refused token retries WITH the profile scope declared, and says it did', async () => {
		const { calls, read } = recorder([REFUSED, WITH_WINDOWS]);
		const result = await escalateUsageRead(read, base, {
			declareProfileScope: true,
			probeIfUnavailable: true,
		});
		assert.equal(calls.length, 2, 'the retry succeeded, so no probe was needed');
		assert.equal(calls[0].oauthScopes, undefined);
		assert.equal(calls[1].oauthScopes, PROFILE_SCOPES);
		assert.equal(result.scopeRetried, true);
	});

	it('the PAID probe fires only when the retry still found nothing AND it was opted into', async () => {
		const optedOut = recorder([REFUSED, REFUSED]);
		await escalateUsageRead(optedOut.read, base, {
			declareProfileScope: true,
			probeIfUnavailable: false,
		});
		assert.equal(optedOut.calls.length, 2, 'no probe without opt-in — it costs money');

		const optedIn = recorder([REFUSED, REFUSED, WITH_WINDOWS]);
		await escalateUsageRead(optedIn.read, base, {
			declareProfileScope: true,
			probeIfUnavailable: true,
		});
		assert.equal(optedIn.calls.length, 3);
		assert.equal(optedIn.calls[2].probePrompt, PROBE_PROMPT);
		assert.equal(optedIn.calls[2].oauthScopes, PROFILE_SCOPES);
	});

	it('fetchedAtMs is captured with the read it describes', async () => {
		const before = Date.now();
		const { read } = recorder([WITH_WINDOWS]);
		const result = await escalateUsageRead(read, base, {
			declareProfileScope: true,
			probeIfUnavailable: false,
		});
		// Every countdown in the report is derived from this, so it must describe THIS read —
		// the tool's old copy stamped it seconds later, from a different clock reading.
		assert.ok(result.fetchedAtMs >= before && result.fetchedAtMs <= Date.now());
	});
});
