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

/** Who the CLI is logged in as. Absent fields mean a 3P provider, where auth is external. */
export type UsageAccount = {
	email?: string;
	organization: string | null;
	subscriptionType: string | null;
	tokenSource: string | null;
	apiKeySource: string | null;
	apiProvider: string | null;
};

export type UsageExtraCredits = {
	isEnabled: boolean;
	monthlyLimit: number | null;
	usedCredits: number | null;
	utilization: number | null;
	currency: string | null;
	/** Why extra usage cannot absorb the overflow — the actionable half of `isEnabled: false`. */
	disabledReason: string | null;
	spendLimitReached: boolean;
};

export type UsageReport = {
	fetchedAt: string;
	claudeCodeVersion: string | null;
	account: UsageAccount;
	/**
	 * False when the CLI has no login at all. Measured: an unauthenticated CLI does not fail the
	 * control requests — it answers with `tokenSource: 'none'` and no plan data, which otherwise looks
	 * exactly like a healthy API-key session. This is the field that tells the two apart.
	 */
	authenticated: boolean;
	subscriptionType: string | null;
	/**
	 * True only when there is at least one window to read. Deliberately not the server's own
	 * `rate_limits_available`: measured on 0.3.202, that flag came back `true` with `rate_limits`
	 * null on consecutive reads of a subscription session. A workflow gating on capacity must not
	 * read "available" and then find no numbers — it would run blind at 92% utilisation.
	 */
	rateLimitsAvailable: boolean;
	/**
	 * The server's flag verbatim: whether plan limits apply to this login at all. False for API key,
	 * Bedrock, Vertex and other 3P sessions. True with an empty `windows` means the limits exist but
	 * this read did not get them.
	 */
	planLimitsApply: boolean;
	windows: UsageWindow[];
	maxUtilization: number | null;
	maxUtilizationKey: string | null;
	nextResetAt: string | null;
	nextResetInSeconds: number | null;
	extraUsage: UsageExtraCredits | null;
	/** This node's own session, opened to ask the question. Always ~zero — never account spend. */
	session: { totalCostUsd: number | null; totalDurationMs: number | null };
	limitsRaw?: unknown[];
	unsupported: boolean;
	diagnostics: {
		initMs: number | null;
		usageMs: number | null;
		unknownBucketKeys: string[];
		/** Plan limits apply to this login, but this read came back without them. Retry, don't conclude. */
		limitsPayloadMissing: boolean;
		/** True when the read was retried declaring the profile scope for a token session. */
		scopeRetried?: boolean;
	};
};

/**
 * Whether a second read declaring `user:profile` is worth trying.
 *
 * A `CLAUDE_CODE_OAUTH_TOKEN` session — the usual headless and Docker setup — gets a synthesised
 * scope list of `['user:inference']`, and the CLI's own gate for plan limits requires `user:profile`.
 * So the first read comes back with `planLimitsApply: false` not because the account lacks plan
 * limits, but because the CLI never asked. Declaring the scope makes it ask.
 *
 * Only worth it for that one credential type: an API key, Bedrock or Vertex session genuinely has no
 * plan limits, and a stored interactive login already carries its real scopes.
 */
export const shouldRetryWithProfileScope = (report: UsageReport): boolean =>
	report.authenticated &&
	!report.planLimitsApply &&
	report.account.tokenSource === 'CLAUDE_CODE_OAUTH_TOKEN';

export type NormalizeUsageInput = {
	/** `initializationResult()` payload, or null when it failed. */
	init: Record<string, unknown> | null;
	/** The experimental usage payload, or null when unsupported or failed. */
	usage: Record<string, unknown> | null;
	claudeCodeVersion?: string | null;
	fetchedAtMs: number;
	includeEmail?: boolean;
	includeRawLimits?: boolean;
	/** True when the SDK no longer exposes the usage control request at all. */
	unsupported?: boolean;
	initMs?: number | null;
	usageMs?: number | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

export function normalizeAccount(
	init: Record<string, unknown> | null,
	includeEmail = false,
): UsageAccount {
	const account = asRecord(init?.account) ?? {};
	const normalized: UsageAccount = {
		organization: stringOrNull(account.organization),
		subscriptionType: stringOrNull(account.subscriptionType),
		tokenSource: stringOrNull(account.tokenSource),
		apiKeySource: stringOrNull(account.apiKeySource),
		apiProvider: stringOrNull(account.apiProvider),
	};

	// Opt-in: the organisation and plan already identify the account for routing decisions, and the
	// email would otherwise end up in every execution's saved data.
	if (includeEmail) {
		const email = stringOrNull(account.email);
		if (email !== null) normalized.email = email;
	}

	return normalized;
}

export function normalizeExtraUsage(rateLimits: unknown): UsageExtraCredits | null {
	const extra = asRecord(asRecord(rateLimits)?.extra_usage);
	if (extra === null) return null;

	return {
		isEnabled: extra.is_enabled === true,
		monthlyLimit: numberOrNull(extra.monthly_limit),
		usedCredits: numberOrNull(extra.used_credits),
		utilization: numberOrNull(extra.utilization),
		currency: stringOrNull(extra.currency),
		disabledReason: stringOrNull(extra.disabled_reason),
		spendLimitReached: extra.spend_limit_reached === true,
	};
}

/**
 * The window that will free up first, among those actually consuming quota. A window at 0% may hold
 * an earlier `resets_at`, and pointing a Wait node at that reset would resume just as early into a
 * window that is still full.
 */
function nextReset(windows: UsageWindow[]): UsageWindow | null {
	const pending = windows
		.filter((w) => (w.utilization ?? 0) > 0 && w.resetsInSeconds !== null)
		.sort((a, b) => (a.resetsInSeconds as number) - (b.resetsInSeconds as number));

	return pending[0] ?? null;
}

/** The binding constraint: `windows` is already sorted, so the first numeric utilization wins. */
function peakWindow(windows: UsageWindow[]): UsageWindow | null {
	return windows.find((w) => w.utilization !== null) ?? null;
}

/**
 * Assembles the item the node emits. Tolerates a null `usage` payload — an API key, Bedrock or
 * Vertex session has no plan limits, and a removed control request leaves the same hole — and still
 * reports the account, because knowing which login n8n is using is useful on its own.
 */
export function normalizeUsage(input: NormalizeUsageInput): UsageReport {
	const rateLimits = asRecord(input.usage?.rate_limits);
	const windows = normalizeWindows(rateLimits, input.fetchedAtMs);
	const peak = peakWindow(windows);
	const upcoming = nextReset(windows);
	const session = asRecord(input.usage?.session);
	const rawLimits = asRecord(rateLimits)?.limits;

	const planLimitsApply = input.usage?.rate_limits_available === true;
	const account = normalizeAccount(input.init, input.includeEmail);

	const report: UsageReport = {
		fetchedAt: new Date(input.fetchedAtMs).toISOString(),
		claudeCodeVersion: input.claudeCodeVersion ?? null,
		account,
		// 'none' is the CLI's own word for "no login". An authenticated session reports a real source,
		// or omits the field entirely — so only the explicit 'none' counts as unauthenticated.
		authenticated: account.tokenSource !== 'none',
		subscriptionType: stringOrNull(input.usage?.subscription_type),
		rateLimitsAvailable: windows.length > 0,
		planLimitsApply,
		windows,
		maxUtilization: peak?.utilization ?? null,
		maxUtilizationKey: peak?.key ?? null,
		nextResetAt: upcoming?.resetsAt ?? null,
		nextResetInSeconds: upcoming?.resetsInSeconds ?? null,
		extraUsage: normalizeExtraUsage(rateLimits),
		session: {
			totalCostUsd: numberOrNull(session?.total_cost_usd),
			totalDurationMs: numberOrNull(session?.total_duration_ms),
		},
		unsupported: input.unsupported === true,
		diagnostics: {
			initMs: input.initMs ?? null,
			usageMs: input.usageMs ?? null,
			unknownBucketKeys: unknownBucketKeys(windows),
			limitsPayloadMissing: planLimitsApply && windows.length === 0,
		},
	};

	if (input.includeRawLimits && Array.isArray(rawLimits)) {
		report.limitsRaw = rawLimits;
	}

	return report;
}
