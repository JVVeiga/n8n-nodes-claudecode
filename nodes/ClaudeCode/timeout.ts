import type { ModelUsage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Pure helpers for reporting what a stopped run actually did. Kept free of n8n and of the SDK's
 * `query()` so they can be unit-tested against hand-written message arrays.
 */

/** A 900s run can produce thousands of tool calls and this report is stored with every failed
 * execution. The tail is kept, not the head: where a run stalled matters more than how it started. */
const TOOL_TIMELINE_LIMIT = 100;

export type UsageTotals = {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
};

export type ToolTimelineEntry = {
	name: string;
	/** Position in the full run, so a truncated timeline still shows where it sits. */
	index: number;
};

export type TerminationReason = 'timeout_graceful' | 'timeout_hard_abort' | 'execution_error';

export type ResultTextSource = 'result' | 'assistant' | null;

export type RunMetrics = {
	usage: UsageTotals | null;
	/** False when no `result` message ever arrived — a hard abort emits none at all. */
	usageReliable: boolean;
	totalCostUsd: number | null;
	numTurns: number | null;
	modelUsage: Record<string, ModelUsage> | null;
	assistantTurns: number;
	toolUseCount: number;
	toolTimeline: ToolTimelineEntry[];
	toolTimelineTruncated: boolean;
	sessionId: string | null;
	resultText: string | null;
	resultTextSource: ResultTextSource;
};

type ResultMessage = Extract<SDKMessage, { type: 'result' }>;
type AssistantMessage = Extract<SDKMessage, { type: 'assistant' }>;
type InitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;

const isResult = (m: SDKMessage): m is ResultMessage => m.type === 'result';
const isAssistant = (m: SDKMessage): m is AssistantMessage => m.type === 'assistant';
const isInit = (m: SDKMessage): m is InitMessage => m.type === 'system' && m.subtype === 'init';

const last = <T>(items: T[]): T | undefined =>
	items.length > 0 ? items[items.length - 1] : undefined;

type ContentBlock = { type?: string; name?: string; text?: string };

const contentOf = (m: AssistantMessage): ContentBlock[] => {
	const content = m.message?.content;
	return Array.isArray(content) ? (content as ContentBlock[]) : [];
};

/**
 * Reads spend and progress from the message stream. A graceful timeout emits TWO result messages,
 * one for the interrupt and one for the wrap-up, and the fields split awkwardly: `total_cost_usd`
 * and `modelUsage` accumulate across turns while `usage` and `num_turns` cover only their own.
 *
 * Never falls back to summing assistant-message `usage` — measured, it under-reports output tokens
 * by more than 20x, so it would be a fabricated number rather than an estimate.
 */
export function collectRunMetrics(messages: SDKMessage[]): RunMetrics {
	const results = messages.filter(isResult);
	const assistants = messages.filter(isAssistant);
	const finalResult = last(results);

	const toolUses: ToolTimelineEntry[] = [];
	let assistantText: string | null = null;
	for (const message of assistants) {
		for (const block of contentOf(message)) {
			if (block.type === 'tool_use' && typeof block.name === 'string') {
				toolUses.push({ name: block.name, index: toolUses.length });
			} else if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
				assistantText = block.text;
			}
		}
	}

	const truncated = toolUses.length > TOOL_TIMELINE_LIMIT;

	// The interrupt's own result always carries `result: null`, so search backwards for one that
	// actually has text before falling back to the transcript.
	let resultText: string | null = null;
	for (let i = results.length - 1; i >= 0 && resultText === null; i--) {
		const candidate = results[i];
		if ('result' in candidate && typeof candidate.result === 'string' && candidate.result !== '') {
			resultText = candidate.result;
		}
	}
	const resultTextSource: ResultTextSource =
		resultText !== null ? 'result' : assistantText !== null ? 'assistant' : null;

	const observable = {
		assistantTurns: assistants.length,
		toolUseCount: toolUses.length,
		toolTimeline: truncated ? toolUses.slice(-TOOL_TIMELINE_LIMIT) : toolUses,
		toolTimelineTruncated: truncated,
		// A graceful timeout re-inits the session after the interrupt, so there can be two init
		// messages. The first one is the authoritative record of the session that was started.
		sessionId: finalResult?.session_id ?? messages.find(isInit)?.session_id ?? null,
		resultText: resultText ?? assistantText,
		resultTextSource,
	};

	const modelUsage = finalResult?.modelUsage;
	if (!modelUsage || Object.keys(modelUsage).length === 0) {
		return {
			usage: null,
			usageReliable: false,
			totalCostUsd: null,
			numTurns: null,
			modelUsage: null,
			...observable,
		};
	}

	const usage = Object.keys(modelUsage).reduce<UsageTotals>(
		(acc, key) => {
			const perModel = modelUsage[key];
			return {
				inputTokens: acc.inputTokens + (perModel.inputTokens || 0),
				outputTokens: acc.outputTokens + (perModel.outputTokens || 0),
				cacheReadInputTokens: acc.cacheReadInputTokens + (perModel.cacheReadInputTokens || 0),
				cacheCreationInputTokens:
					acc.cacheCreationInputTokens + (perModel.cacheCreationInputTokens || 0),
			};
		},
		{ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
	);

	return {
		usage,
		usageReliable: true,
		totalCostUsd:
			typeof finalResult.total_cost_usd === 'number' ? finalResult.total_cost_usd : null,
		numTurns: results.reduce((sum, r) => sum + (r.num_turns || 0), 0),
		modelUsage,
		...observable,
	};
}

export type GraceWindow = {
	/** When to interrupt and ask for a wrap-up, or null when the wrap-up is disabled. */
	wrapUpAtMs: number | null;
	/** When to abort unconditionally. Always set — the backstop for a hung wrap-up. */
	hardAbortAtMs: number;
	/** The grace actually applied, after clamping. */
	graceSeconds: number;
};

/**
 * The grace is carved out of the timeout rather than added to it, so a node configured for 900s
 * never runs longer than 900s.
 */
export function resolveGraceWindow(timeoutSeconds: number, graceSeconds: number): GraceWindow {
	const hardAbortAtMs = timeoutSeconds * 1000;
	const clamped = Math.min(Math.max(graceSeconds, 0), Math.floor(timeoutSeconds / 2));

	return {
		wrapUpAtMs: clamped > 0 ? (timeoutSeconds - clamped) * 1000 : null,
		hardAbortAtMs,
		graceSeconds: clamped,
	};
}

export type TimeoutPayloadInput = {
	metrics: RunMetrics;
	terminationReason: TerminationReason;
	timeoutSeconds: number;
	graceSeconds: number;
	wrapUpSucceeded: boolean;
	durationMs: number;
	messageCount: number;
	diagnostics: Record<string, unknown> | null;
};

export type TimeoutPayload = Record<string, unknown>;

/** Builds the report emitted on every timeout path. */
export function buildTimeoutPayload(input: TimeoutPayloadInput): TimeoutPayload {
	const { metrics } = input;

	return {
		error: formatTimeoutMessage(input),
		errorType: 'timeout',
		timedOut: true,
		terminationReason: input.terminationReason,
		timeoutSeconds: input.timeoutSeconds,
		wrapUpGraceSeconds: input.graceSeconds,
		wrapUpSucceeded: input.wrapUpSucceeded,
		result: metrics.resultText,
		resultSource:
			metrics.resultTextSource === 'result'
				? 'wrap_up'
				: metrics.resultTextSource === 'assistant'
					? 'last_assistant_text'
					: null,
		duration_ms: input.durationMs,
		num_turns: metrics.numTurns,
		total_cost_usd: metrics.totalCostUsd,
		usage: metrics.usage,
		usageReliable: metrics.usageReliable,
		modelUsage: metrics.modelUsage,
		session_id: metrics.sessionId,
		assistantTurns: metrics.assistantTurns,
		toolUseCount: metrics.toolUseCount,
		toolTimeline: metrics.toolTimeline,
		toolTimelineTruncated: metrics.toolTimelineTruncated,
		messageCount: input.messageCount,
		diagnostics: input.diagnostics,
	};
}

const formatCost = (cost: number | null): string =>
	cost === null
		? 'cost unknown'
		: `$${cost.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} spent`;

const formatTurns = (turns: number | null, assistantTurns: number): string =>
	turns === null ? `${assistantTurns} assistant turns` : `${turns} turns`;

/**
 * The `error.message`. n8n's error panel renders this and the description and nothing else — not
 * `error.context` — so it has to name the timeout and carry the headline numbers on its own.
 */
export function formatTimeoutMessage(input: TimeoutPayloadInput): string {
	const { metrics } = input;
	const outcome =
		input.terminationReason === 'timeout_graceful' && input.wrapUpSucceeded
			? 'wrap-up summary returned'
			: input.terminationReason === 'timeout_graceful'
				? 'wrap-up did not finish'
				: 'process aborted, no summary';

	const session = metrics.sessionId === null ? 'no session id' : `session ${metrics.sessionId}`;

	return `Claude Code timed out after ${input.timeoutSeconds}s (${outcome}) — ${formatTurns(
		metrics.numTurns,
		metrics.assistantTurns,
	)}, ${formatCost(metrics.totalCostUsd)}, ${session}`;
}

export function formatTimeoutDescription(input: TimeoutPayloadInput): string {
	const { metrics } = input;
	const parts: string[] = [`Grace window: ${input.graceSeconds}s.`];

	if (metrics.usage === null) {
		parts.push(
			'Token counts are unavailable: a hard abort emits no result message, and per-message usage cannot be summed reliably.',
		);
	} else {
		parts.push(
			`Tokens: ${metrics.usage.inputTokens} in / ${metrics.usage.outputTokens} out / ${metrics.usage.cacheReadInputTokens} cache read / ${metrics.usage.cacheCreationInputTokens} cache write.`,
		);
	}

	if (metrics.modelUsage !== null) {
		parts.push(`Models: ${Object.keys(metrics.modelUsage).join(', ')}.`);
	}

	parts.push(
		`Tools used: ${metrics.toolUseCount}${metrics.toolTimelineTruncated ? ` (timeline shows the last ${TOOL_TIMELINE_LIMIT})` : ''}.`,
	);

	parts.push(
		metrics.sessionId === null
			? 'No session id was captured, so this run cannot be resumed.'
			: `Resume with the Continue operation and session id ${metrics.sessionId}.`,
	);

	return parts.join(' ');
}
