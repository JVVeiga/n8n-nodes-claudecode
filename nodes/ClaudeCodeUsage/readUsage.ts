import { query } from '@anthropic-ai/claude-agent-sdk';
import { createPromptStream } from '../ClaudeCode/promptStream';

/**
 * The control request behind the CLI's `/usage`. The name is the SDK's own warning label — it is
 * documented as unstable and free to disappear in any release — so it is read off the object rather
 * than called directly, and its absence degrades to `unsupported` instead of throwing.
 */
const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

/** Which control request was in flight when the deadline hit — the useful half of a timeout. */
export type UsageStage = 'initialize' | 'probe' | 'usage';

export class UsageReadTimeoutError extends Error {
	constructor(
		readonly stage: UsageStage,
		readonly timeoutMs: number,
	) {
		super(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the ${stage} step`);
		this.name = 'UsageReadTimeoutError';
	}
}

/**
 * Scopes to declare for a `CLAUDE_CODE_OAUTH_TOKEN` session so the CLI will look up plan limits.
 *
 * Measured against CLI 2.1.219: the payload's `rate_limits_available` is
 * `hasScope('user:inference') && hasScope('user:profile')`, and for an env-token session the scope
 * list is synthesised from `CLAUDE_CODE_OAUTH_SCOPES`, defaulting to `['user:inference']` alone. So a
 * token session never even attempts the lookup — the CLI censors itself before asking.
 *
 * Declaring the scope grants nothing: the token still has whatever the server issued it. With a token
 * that lacks the scope the request is simply made and refused, which surfaces as
 * `rateLimitsAvailable: false` with `diagnostics.limitsPayloadMissing: true`.
 */
export const PROFILE_SCOPES = 'user:inference user:profile';

export type UsageReadOptions = {
	cwd?: string;
	timeoutMs: number;
	pathToClaudeCodeExecutable?: string;
	/** Value for `CLAUDE_CODE_OAUTH_SCOPES` in the spawned CLI's environment. */
	oauthScopes?: string;
	/**
	 * Send this prompt and wait for its result before asking for usage, so the CLI has rate-limit
	 * response headers to seed from. Costs a real (tiny) inference — see {@link PROBE_PROMPT}.
	 */
	probePrompt?: string;
};

/**
 * The probe turn. Deliberately trivial: its only job is to make one API call so the response carries
 * `anthropic-ratelimit-unified-5h-*` and `-7d-*` headers, which the CLI harvests and reports as
 * seeded utilisation when the usage endpoint is closed to this credential.
 */
export const PROBE_PROMPT = 'Reply with the single word: ok';

/** Cheapest model that can answer the probe. */
const PROBE_MODEL = 'haiku';

export type UsageReadResult = {
	init: Record<string, unknown> | null;
	usage: Record<string, unknown> | null;
	/**
	 * Comes from the session's system init message, which the CLI only emits once a turn runs. Measured:
	 * a probe read reports it (`2.1.233` in a container), a free read leaves it null.
	 */
	claudeCodeVersion: string | null;
	initMs: number | null;
	usageMs: number | null;
	unsupported: boolean;
	/** What the probe turn cost, when one was sent. */
	probeCostUsd: number | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const elapsedMsSince = (startedAt: bigint): number =>
	Number(process.hrtime.bigint() - startedAt) / 1e6;

/**
 * Opens a session, asks it who it is and how much of the plan is left, and closes it. Without
 * `probePrompt` no user turn is ever pushed, so the read is free: measured on 0.3.202 the session
 * reports `total_cost_usd: 0` and no assistant message. With one, it costs that turn — around $0.001
 * on Haiku — and `probeCostUsd` reports what it was.
 *
 * The session is closed and aborted in `finally`, and this function never returns from inside the
 * `try`. n8n is long-lived — a CLI process leaked once per execution compounds until the container
 * dies, which is the worst failure this node could have.
 */
export async function readUsage(options: UsageReadOptions): Promise<UsageReadResult> {
	const result: UsageReadResult = {
		init: null,
		usage: null,
		claudeCodeVersion: null,
		initMs: null,
		usageMs: null,
		unsupported: false,
		probeCostUsd: null,
	};

	// Without a probe there is no initial prompt at all: the stream keeps the session open for the
	// control requests without ever yielding a turn to answer, so the read is free.
	const promptStream = createPromptStream(options.probePrompt);
	const abortController = new AbortController();
	let stage: UsageStage = 'initialize';
	let timer: NodeJS.Timeout | undefined;
	let onProbeResult: ((cost: number | null) => void) | undefined;
	const probeFinished = options.probePrompt
		? new Promise<number | null>((resolve) => {
				onProbeResult = resolve;
			})
		: null;

	const runningQuery = query({
		prompt: promptStream.stream,
		options: {
			abortController,
			...(options.cwd ? { cwd: options.cwd } : {}),
			...(options.pathToClaudeCodeExecutable
				? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }
				: {}),
			...(options.oauthScopes
				? { env: { ...process.env, CLAUDE_CODE_OAUTH_SCOPES: options.oauthScopes } }
				: {}),
			...(options.probePrompt ? { model: PROBE_MODEL, tools: [] } : {}),
		},
	});

	// Kept consuming in the background: the control responses arrive on the same transport as the
	// message stream, and an unread stream is a stalled read. Nothing here needs the messages
	// themselves — except the version, if the CLI volunteers it.
	const drained = (async () => {
		for await (const message of runningQuery) {
			if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') {
				const version = (message as { claude_code_version?: unknown }).claude_code_version;
				if (typeof version === 'string') result.claudeCodeVersion = version;
			}
			// The probe's turn is finished, so its response headers are in hand. Do not break out of
			// this loop: the session has to stay open for the usage request that follows.
			if (message.type === 'result' && onProbeResult) {
				const cost = (message as { total_cost_usd?: unknown }).total_cost_usd;
				onProbeResult(typeof cost === 'number' ? cost : null);
				onProbeResult = undefined;
			}
		}
	})().catch(() => {
		// The abort in `finally` ends this loop by design, and a transport error here is already
		// reported by whichever control request failed.
	});

	try {
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				abortController.abort();
				reject(new UsageReadTimeoutError(stage, options.timeoutMs));
			}, options.timeoutMs);
		});

		const initStartedAt = process.hrtime.bigint();
		const init = await Promise.race([runningQuery.initializationResult(), deadline]);
		result.initMs = Math.round(elapsedMsSince(initStartedAt));
		result.init = asRecord(init);

		// Ask only after the probe's answer has landed: the rate-limit headers the CLI seeds from are
		// filled in by that response, and asking earlier reads them empty.
		if (probeFinished) {
			stage = 'probe';
			result.probeCostUsd = await Promise.race([probeFinished, deadline]);
		}

		const readUsagePayload = (runningQuery as unknown as Record<string, unknown>)[USAGE_METHOD];
		if (typeof readUsagePayload !== 'function') {
			// The SDK dropped or renamed the request. The account data is still worth returning.
			result.unsupported = true;
		} else {
			stage = 'usage';
			const usageStartedAt = process.hrtime.bigint();
			const usage = await Promise.race([
				(readUsagePayload as () => Promise<unknown>).call(runningQuery),
				deadline,
			]);
			result.usageMs = Math.round(elapsedMsSince(usageStartedAt));
			result.usage = asRecord(usage);
		}
	} finally {
		if (timer) clearTimeout(timer);
		promptStream.close();
		abortController.abort();
		await drained;
	}

	return result;
}
