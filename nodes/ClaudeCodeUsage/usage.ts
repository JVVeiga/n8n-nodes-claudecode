/**
 * Normalisers for the SDK's usage payload. Pure on purpose: no SDK calls, no n8n imports, so the
 * shape rules are testable against captured payloads instead of a live session.
 *
 * The SDK's declared `rate_limits` type is narrower than what the server actually sends. Measured
 * against 0.3.202, a Team session also returned `seven_day_cowork`, `seven_day_omelette`,
 * `tangelo`, `iguana_necktie`, `nimbus_quill`, `cinder_cove`, `amber_ladder` and
 * `omelette_promotional`, plus `limits[]` and per-window `limit_dollars` / `used_dollars` /
 * `remaining_dollars` — none of them in `sdk.d.ts`. So every function here walks the object it is
 * given rather than reading a known field list: an unknown bucket is data, not noise.
 */

/** One plan window (5-hour, 7-day, per-model, …) as the node reports it. */
export type UsageWindow = {
	/** The server's bucket key, never renamed — a new bucket shows up as data instead of vanishing. */
	key: string;
	/** Percentage of the window consumed, 0-100. */
	utilization: number | null;
	/**
	 * Verbatim as the server sent it, offset and sub-second precision included
	 * (`2026-08-19T06:10:00.394384+00:00`). Reshaping it would invent precision the node does not
	 * have; `resetsInSeconds` is the field to compare against.
	 */
	resetsAt: string | null;
	resetsInSeconds: number | null;
	limitDollars: number | null;
	usedDollars: number | null;
	remainingDollars: number | null;
};

/** Keys inside `rate_limits` that are not windows and must never reach `windows`. */
const NON_WINDOW_KEYS = new Set(['limits', 'extra_usage']);

/** Guards against the server sending `"72"`, `null` or an object where a number belongs. */
export const numberOrNull = (value: unknown): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? value : null;

const stringOrNull = (value: unknown): string | null =>
	typeof value === 'string' && value !== '' ? value : null;

/**
 * Seconds from `fromMs` until `isoTimestamp`. Clamped at zero: a window whose reset already passed
 * is due now, and a negative countdown in a Wait node is worse than a zero.
 */
export function secondsUntil(isoTimestamp: string, fromMs: number): number | null {
	const target = Date.parse(isoTimestamp);
	if (Number.isNaN(target)) return null;
	return Math.max(0, Math.round((target - fromMs) / 1000));
}

const isWindowObject = (value: unknown): boolean =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Every bucket the server actually returned, sorted by utilization descending so the binding
 * constraint reads first. Buckets that came back `null` — the plan does not have them — are
 * dropped; unknown keys are kept.
 *
 * Every countdown derives from the single `fetchedAtMs` the caller captured, so the numbers within
 * one item agree with each other and with `fetchedAt`.
 */
export function normalizeWindows(
	rateLimits: Record<string, unknown> | null | undefined,
	fetchedAtMs: number,
): UsageWindow[] {
	if (!rateLimits) return [];

	return Object.entries(rateLimits)
		.filter(([key, value]) => !NON_WINDOW_KEYS.has(key) && isWindowObject(value))
		.map(([key, value]) => {
			const raw = value as Record<string, unknown>;
			const resetsAt = stringOrNull(raw.resets_at);
			return {
				key,
				utilization: numberOrNull(raw.utilization),
				resetsAt,
				resetsInSeconds: resetsAt === null ? null : secondsUntil(resetsAt, fetchedAtMs),
				limitDollars: numberOrNull(raw.limit_dollars),
				usedDollars: numberOrNull(raw.used_dollars),
				remainingDollars: numberOrNull(raw.remaining_dollars),
			};
		})
		.sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1));
}

/**
 * Bucket keys the SDK's type does declare. Anything else is reported under
 * `diagnostics.unknownBucketKeys` so a server-side addition is visible rather than silent.
 */
const DECLARED_BUCKET_KEYS = new Set([
	'five_hour',
	'seven_day',
	'seven_day_oauth_apps',
	'seven_day_opus',
	'seven_day_sonnet',
	'model_scoped',
]);

export const unknownBucketKeys = (windows: UsageWindow[]): string[] =>
	windows.map((w) => w.key).filter((key) => !DECLARED_BUCKET_KEYS.has(key));
