import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	normalizeAccount,
	normalizeExtraUsage,
	normalizeUsage,
	normalizeWindows,
	numberOrNull,
	secondsUntil,
	unknownBucketKeys,
} from '../nodes/ClaudeCodeUsage/usage';

/**
 * Captured from a live 0.3.202 Team session rather than written by hand, so the fixtures carry the
 * fields the server really sends — including the buckets and the `*_dollars` fields that are absent
 * from `sdk.d.ts`.
 */
const TEAM_RATE_LIMITS = {
	five_hour: {
		utilization: 72,
		resets_at: '2026-08-19T06:10:00.394384+00:00',
		limit_dollars: null,
		used_dollars: null,
		remaining_dollars: null,
	},
	seven_day: {
		utilization: 11,
		resets_at: '2026-08-25T20:00:00.394413+00:00',
		limit_dollars: null,
		used_dollars: null,
		remaining_dollars: null,
	},
	seven_day_oauth_apps: null,
	seven_day_opus: null,
	seven_day_sonnet: null,
	seven_day_cowork: null,
	seven_day_omelette: null,
	tangelo: null,
	iguana_necktie: null,
	omelette_promotional: null,
	nimbus_quill: {
		utilization: 0,
		resets_at: null,
		limit_dollars: null,
		used_dollars: null,
		remaining_dollars: null,
	},
	cinder_cove: null,
	amber_ladder: null,
	extra_usage: {
		is_enabled: true,
		monthly_limit: 0,
		used_credits: 0,
		utilization: null,
		currency: 'BRL',
	},
	limits: [
		{ kind: 'session', group: 'session', percent: 72, severity: 'normal', is_active: true },
		{ kind: 'weekly_all', group: 'weekly', percent: 11, severity: 'normal', is_active: false },
	],
};

/** 2026-08-19T05:12:03.114Z — a fixed "now" so the countdowns are deterministic. */
const FETCHED_AT_MS = Date.parse('2026-08-19T05:12:03.114Z');

describe('secondsUntil', () => {
	it('counts down to the reset', () => {
		assert.equal(secondsUntil('2026-08-19T06:10:00.394384+00:00', FETCHED_AT_MS), 3477);
	});

	it('clamps a reset that already passed, so a Wait node never gets a negative', () => {
		assert.equal(secondsUntil('2026-08-19T04:00:00+00:00', FETCHED_AT_MS), 0);
	});

	it('returns null for an unparseable timestamp instead of NaN', () => {
		assert.equal(secondsUntil('not a date', FETCHED_AT_MS), null);
	});
});

describe('numberOrNull', () => {
	it('rejects the string the server might send instead of a number', () => {
		assert.equal(numberOrNull('72'), null);
	});

	it('rejects NaN and Infinity, which would serialise as null anyway', () => {
		assert.equal(numberOrNull(Number.NaN), null);
		assert.equal(numberOrNull(Number.POSITIVE_INFINITY), null);
	});

	it('keeps zero, which is a real utilization', () => {
		assert.equal(numberOrNull(0), 0);
	});
});

describe('normalizeWindows', () => {
	it('maps the live payload, ordered by utilization descending', () => {
		const windows = normalizeWindows(TEAM_RATE_LIMITS, FETCHED_AT_MS);

		assert.deepEqual(
			windows.map((w) => w.key),
			['five_hour', 'seven_day', 'nimbus_quill'],
		);
		assert.deepEqual(windows[0], {
			key: 'five_hour',
			utilization: 72,
			resetsAt: '2026-08-19T06:10:00.394384+00:00',
			resetsInSeconds: 3477,
			limitDollars: null,
			usedDollars: null,
			remainingDollars: null,
		});
	});

	it('keeps a bucket the SDK type never declared, key intact', () => {
		const windows = normalizeWindows(TEAM_RATE_LIMITS, FETCHED_AT_MS);
		const codenamed = windows.find((w) => w.key === 'nimbus_quill');

		assert.equal(codenamed?.utilization, 0);
		assert.equal(codenamed?.resetsInSeconds, null);
		assert.deepEqual(unknownBucketKeys(windows), ['nimbus_quill']);
	});

	it('drops buckets the plan does not have', () => {
		const keys = normalizeWindows(TEAM_RATE_LIMITS, FETCHED_AT_MS).map((w) => w.key);

		assert.equal(keys.includes('tangelo'), false);
		assert.equal(keys.includes('seven_day_opus'), false);
	});

	it('never leaks extra_usage or limits into the windows', () => {
		const keys = normalizeWindows(TEAM_RATE_LIMITS, FETCHED_AT_MS).map((w) => w.key);

		assert.equal(keys.includes('extra_usage'), false);
		assert.equal(keys.includes('limits'), false);
	});

	it('returns nothing when plan limits do not apply', () => {
		assert.deepEqual(normalizeWindows(null, FETCHED_AT_MS), []);
		assert.deepEqual(normalizeWindows(undefined, FETCHED_AT_MS), []);
	});

	it('survives a malformed payload without throwing', () => {
		const windows = normalizeWindows(
			{
				five_hour: { utilization: '72', resets_at: 12345, limit_dollars: 'ten' },
				seven_day: 'not an object',
				weird_array: [1, 2, 3],
			},
			FETCHED_AT_MS,
		);

		assert.deepEqual(windows, [
			{
				key: 'five_hour',
				utilization: null,
				resetsAt: null,
				resetsInSeconds: null,
				limitDollars: null,
				usedDollars: null,
				remainingDollars: null,
			},
		]);
	});

	it('carries the dollar fields through when the server sends them', () => {
		const windows = normalizeWindows(
			{
				five_hour: {
					utilization: 40,
					resets_at: null,
					limit_dollars: 100,
					used_dollars: 40,
					remaining_dollars: 60,
				},
			},
			FETCHED_AT_MS,
		);

		assert.equal(windows[0].limitDollars, 100);
		assert.equal(windows[0].usedDollars, 40);
		assert.equal(windows[0].remainingDollars, 60);
	});
});

const TEAM_INIT = {
	account: {
		email: 'someone@example.com',
		organization: 'Gaudium',
		subscriptionType: 'Claude Team',
		apiProvider: 'firstParty',
	},
	models: [{ id: 'claude-opus-5' }],
};

const TEAM_USAGE = {
	session: { total_cost_usd: 0, total_duration_ms: 2111, model_usage: {} },
	subscription_type: 'team',
	rate_limits_available: true,
	rate_limits: TEAM_RATE_LIMITS,
};

describe('normalizeAccount', () => {
	it('withholds the email unless it was asked for', () => {
		const account = normalizeAccount(TEAM_INIT);

		assert.equal('email' in account, false);
		assert.equal(account.organization, 'Gaudium');
		assert.equal(account.apiProvider, 'firstParty');
	});

	it('includes the email when the toggle is on', () => {
		assert.equal(normalizeAccount(TEAM_INIT, true).email, 'someone@example.com');
	});

	it('reports nulls rather than throwing when initialize failed', () => {
		assert.deepEqual(normalizeAccount(null), {
			organization: null,
			subscriptionType: null,
			tokenSource: null,
			apiKeySource: null,
			apiProvider: null,
		});
	});
});

describe('normalizeExtraUsage', () => {
	it('maps the credit pool, including why it is unusable', () => {
		const extra = normalizeExtraUsage({
			extra_usage: {
				is_enabled: false,
				monthly_limit: 50,
				used_credits: 12.5,
				utilization: 25,
				currency: 'BRL',
				disabled_reason: 'out_of_credits',
				spend_limit_reached: true,
			},
		});

		assert.deepEqual(extra, {
			isEnabled: false,
			monthlyLimit: 50,
			usedCredits: 12.5,
			utilization: 25,
			currency: 'BRL',
			disabledReason: 'out_of_credits',
			spendLimitReached: true,
		});
	});

	it('is null when the payload has no credit pool at all', () => {
		assert.equal(normalizeExtraUsage({}), null);
		assert.equal(normalizeExtraUsage(null), null);
	});
});

describe('normalizeUsage', () => {
	it('assembles the live Team payload', () => {
		const report = normalizeUsage({
			init: TEAM_INIT,
			usage: TEAM_USAGE,
			claudeCodeVersion: '2.1.0',
			fetchedAtMs: FETCHED_AT_MS,
			initMs: 1886,
			usageMs: 819,
		});

		assert.equal(report.fetchedAt, '2026-08-19T05:12:03.114Z');
		assert.equal(report.claudeCodeVersion, '2.1.0');
		assert.equal(report.subscriptionType, 'team');
		assert.equal(report.rateLimitsAvailable, true);
		assert.equal(report.planLimitsApply, true);
		assert.equal(report.diagnostics.limitsPayloadMissing, false);
		assert.equal(report.maxUtilization, 72);
		assert.equal(report.maxUtilizationKey, 'five_hour');
		assert.equal(report.nextResetAt, '2026-08-19T06:10:00.394384+00:00');
		assert.equal(report.nextResetInSeconds, 3477);
		assert.equal(report.unsupported, false);
		assert.deepEqual(report.diagnostics, {
			initMs: 1886,
			usageMs: 819,
			unknownBucketKeys: ['nimbus_quill'],
			limitsPayloadMissing: false,
		});
	});

	it('reports its own session cost, which is the read and not account spend', () => {
		const report = normalizeUsage({
			init: TEAM_INIT,
			usage: TEAM_USAGE,
			fetchedAtMs: FETCHED_AT_MS,
		});

		assert.deepEqual(report.session, { totalCostUsd: 0, totalDurationMs: 2111 });
	});

	// A window at 0% can hold an earlier reset; waiting for it would resume into a still-full window.
	it('picks the next reset among windows actually consuming quota', () => {
		const report = normalizeUsage({
			init: TEAM_INIT,
			usage: {
				rate_limits_available: true,
				rate_limits: {
					idle_soon: { utilization: 0, resets_at: '2026-08-19T05:20:00+00:00' },
					busy_later: { utilization: 90, resets_at: '2026-08-19T07:00:00+00:00' },
				},
			},
			fetchedAtMs: FETCHED_AT_MS,
		});

		assert.equal(report.nextResetAt, '2026-08-19T07:00:00+00:00');
		assert.equal(report.maxUtilizationKey, 'busy_later');
	});

	it('holds up on an API-key session, where plan limits do not apply', () => {
		const report = normalizeUsage({
			init: { account: { apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' } },
			usage: {
				session: { total_cost_usd: 0 },
				subscription_type: null,
				rate_limits_available: false,
				rate_limits: null,
			},
			fetchedAtMs: FETCHED_AT_MS,
		});

		assert.equal(report.rateLimitsAvailable, false);
		assert.equal(report.planLimitsApply, false);
		assert.deepEqual(report.windows, []);
		assert.equal(report.maxUtilization, null);
		assert.equal(report.maxUtilizationKey, null);
		assert.equal(report.nextResetAt, null);
		assert.equal(report.extraUsage, null);
		assert.equal(report.account.apiKeySource, 'ANTHROPIC_API_KEY');
		// Nothing to retry for: this login has no plan limits at all.
		assert.equal(report.diagnostics.limitsPayloadMissing, false);
	});

	/**
	 * Measured on 0.3.202: consecutive reads of the same Team session returned
	 * `rate_limits_available: true` with `rate_limits: null`, contradicting the SDK's own docs. A
	 * workflow gating on capacity must not read "available" and find no numbers, so the reported flag
	 * follows the numbers and the contradiction surfaces as a diagnostic.
	 */
	it('does not claim limits are available when the payload arrived without them', () => {
		const report = normalizeUsage({
			init: TEAM_INIT,
			usage: {
				session: { total_cost_usd: 0 },
				subscription_type: 'team',
				rate_limits_available: true,
				rate_limits: null,
			},
			fetchedAtMs: FETCHED_AT_MS,
		});

		assert.equal(report.rateLimitsAvailable, false);
		assert.equal(report.planLimitsApply, true);
		assert.equal(report.diagnostics.limitsPayloadMissing, true);
		assert.equal(report.maxUtilization, null);
	});

	/**
	 * Measured inside n8n with an empty HOME: an unauthenticated CLI answers both control requests
	 * without failing, reporting `tokenSource: 'none'` and no plan data — which is otherwise
	 * indistinguishable from a healthy API-key session.
	 */
	it('flags an unauthenticated CLI, which otherwise looks like an API-key session', () => {
		const report = normalizeUsage({
			init: { account: { tokenSource: 'none', apiProvider: 'firstParty' } },
			usage: { rate_limits_available: false, rate_limits: null },
			fetchedAtMs: FETCHED_AT_MS,
		});

		assert.equal(report.authenticated, false);
		assert.equal(report.planLimitsApply, false);
		assert.deepEqual(report.windows, []);
	});

	it('treats an absent tokenSource as authenticated, since a real login omits it', () => {
		assert.equal(
			normalizeUsage({ init: TEAM_INIT, usage: TEAM_USAGE, fetchedAtMs: FETCHED_AT_MS })
				.authenticated,
			true,
		);
	});

	it('degrades to a report instead of throwing when the control request is gone', () => {
		const report = normalizeUsage({
			init: TEAM_INIT,
			usage: null,
			fetchedAtMs: FETCHED_AT_MS,
			unsupported: true,
		});

		assert.equal(report.unsupported, true);
		assert.equal(report.rateLimitsAvailable, false);
		assert.deepEqual(report.windows, []);
		assert.equal(report.account.organization, 'Gaudium');
	});

	it('omits limitsRaw unless it was asked for', () => {
		const base = { init: TEAM_INIT, usage: TEAM_USAGE, fetchedAtMs: FETCHED_AT_MS };

		assert.equal('limitsRaw' in normalizeUsage(base), false);
		assert.equal(normalizeUsage({ ...base, includeRawLimits: true }).limitsRaw?.length, 2);
	});
});
