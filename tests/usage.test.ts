import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
