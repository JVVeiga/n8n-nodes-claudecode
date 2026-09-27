import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { IDataObject } from 'n8n-workflow';
import { findInit, isResult, lastResult } from '../../shared/sdkMessage';

/**
 * The `metrics` object — one builder, two consumers.
 *
 * It lives beside the output envelope because that is what defines it: `output/v12.ts` puts this
 * on every item the main node emits. The sub-nodes report the SAME object to a collector
 * workflow, and a collector written for one must ingest the other — so the parity is structural
 * rather than a promise, and a test compares the two.
 *
 * Read from the LAST result message (F-07: on a graceful timeout the first is the interrupt's
 * own per-turn count, the last is the cumulative one).
 */

type ResultLike = {
	duration_ms?: number;
	num_turns?: number;
	total_cost_usd?: number;
	usage?: unknown;
	modelUsage?: unknown;
	session_id?: string;
};

/** A number the SDK actually reported, or null. Never a zero standing in for "unknown". */
const reported = (value: number | undefined): number | null =>
	typeof value === 'number' ? value : null;

export function buildRunMetrics(messages: SDKMessage[], durationMs: number): IDataObject {
	const result = lastResult(messages) as ResultLike | undefined;
	return {
		// The SDK's own duration when it reported one, otherwise the wall time we measured. Both
		// are real; neither is invented.
		duration_ms: reported(result?.duration_ms) ?? durationMs,
		num_turns: reported(result?.num_turns),
		total_cost_usd: reported(result?.total_cost_usd),
		usage: result?.usage ?? null,
		modelUsage: result?.modelUsage ?? null,
		// `usage` and `modelUsage` pass through verbatim: a collector reads deep into them —
		// `usage.cache_creation.ephemeral_1h_input_tokens`,
		// `usage.server_tool_use.web_search_requests` — and normalising here would silently drop
		// whatever the SDK adds next.
		session_id: result?.session_id ?? findInit(messages)?.session_id ?? null,
	};
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** Numbers add, objects merge key by key, arrays concatenate (each entry is one turn's own);
 * anything else — a tier, a speed — is taken from the later result when it has one. */
function addUsage(earlier: unknown, later: unknown): unknown {
	if (later === undefined || later === null) return earlier ?? later;
	if (earlier === undefined || earlier === null) return later;
	if (typeof earlier === 'number' && typeof later === 'number') return earlier + later;
	if (Array.isArray(earlier) && Array.isArray(later)) return [...earlier, ...later];
	if (isPlainObject(earlier) && isPlainObject(later)) {
		const sum: Record<string, unknown> = { ...earlier };
		for (const [key, value] of Object.entries(later)) sum[key] = addUsage(earlier[key], value);
		return sum;
	}
	return later;
}

const addReported = (values: Array<number | undefined>): number | null => {
	const present = values.filter((v): v is number => typeof v === 'number');
	return present.length ? present.reduce((a, b) => a + b, 0) : null;
};

/**
 * `buildRunMetrics` over a run that wrote several results — one per turn when a background
 * subagent's report starts a new one. In a streaming session `duration_ms`, `num_turns` and
 * `usage` cover their own turn, so they are summed; `total_cost_usd`, `modelUsage` and the
 * session id are cumulative and stay from the last. With one result the two are identical.
 */
export function buildSummedRunMetrics(messages: SDKMessage[], durationMs: number): IDataObject {
	const results = messages.filter(isResult) as ResultLike[];
	const last = buildRunMetrics(messages, durationMs);
	if (results.length < 2) return last;
	const usage = results.reduce<unknown>((sum, r) => addUsage(sum, r.usage), undefined);
	return {
		...last,
		duration_ms: addReported(results.map((r) => r.duration_ms)) ?? durationMs,
		num_turns: addReported(results.map((r) => r.num_turns)),
		usage: (usage ?? null) as IDataObject | null,
	};
}
