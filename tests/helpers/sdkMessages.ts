import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * SDKMessage fixture factories, shared by every test.
 *
 * The values here were taken from real runs rather than invented — `modelUsage` in particular has
 * a shape and a magnitude that matter: `total_cost_usd` and `modelUsage` accumulate across turns
 * while `usage` and `num_turns` cover only their own turn. A fixture that gets that wrong makes
 * collectRunMetrics look correct when it is not.
 *
 * Originally inline in timeout.test.ts. Extracted so the golden-fixture tests, the config tests
 * and the harness tests all describe the same stream.
 */

export const SESSION = '1e76098f-2bf5-424d-9694-d1feab1cfc12';

/** SDK message types carry many required fields that are irrelevant here. Fixtures stay readable
 * by asserting the shape rather than spelling out every field. */
export const msg = (shape: object): SDKMessage => shape as unknown as SDKMessage;

export const init = (over: { sessionId?: string; model?: string; tools?: string[] } = {}) =>
	msg({
		type: 'system',
		subtype: 'init',
		model: over.model ?? 'claude-sonnet-5',
		tools: over.tools ?? [],
		session_id: over.sessionId ?? SESSION,
	});

export const assistantText = (text: string) =>
	msg({ type: 'assistant', message: { content: [{ type: 'text', text }] }, session_id: SESSION });

export const assistantTool = (name: string, usageOutputTokens = 3) =>
	msg({
		type: 'assistant',
		message: {
			content: [{ type: 'tool_use', name, input: {} }],
			// Placeholder values — the real SDK reports these per message and they do NOT add up to
			// the session total. Present here specifically so a test can prove we ignore them.
			usage: { input_tokens: 2, output_tokens: usageOutputTokens, cache_read_input_tokens: 10 },
		},
		session_id: SESSION,
	});

export const assistantThinking = (thinking = 'considering the options') =>
	msg({
		type: 'assistant',
		message: { content: [{ type: 'thinking', thinking }] },
		session_id: SESSION,
	});

export const userToolResult = (content = 'ok') =>
	msg({
		type: 'user',
		message: { content: [{ type: 'tool_result', content }] },
		session_id: SESSION,
	});

export const model = (over: Partial<Record<string, number>> = {}) => ({
	inputTokens: 4,
	outputTokens: 486,
	cacheReadInputTokens: 65361,
	cacheCreationInputTokens: 23578,
	webSearchRequests: 0,
	costUSD: 0.16837829999999998,
	contextWindow: 1000000,
	maxOutputTokens: 64000,
	...over,
});

/** The interrupt's own result, values taken from a real run. Per-turn counts, no text. */
export const interruptResult = msg({
	type: 'result',
	subtype: 'error_during_execution',
	num_turns: 5,
	total_cost_usd: 0.16837829999999998,
	usage: { input_tokens: 4, output_tokens: 486 },
	modelUsage: { 'claude-sonnet-5': model() },
	stop_reason: 'tool_use',
	terminal_reason: 'aborted_tools',
	is_error: true,
	errors: ['[ede_diagnostic] result_type=user'],
	session_id: SESSION,
});

export const WRAP_UP_TEXT =
	'- Read `claudecode.svg`.\n- Left: describe `ClaudeCode.node.ts`.\n- Next: read it.';

/** The wrap-up turn's result. Note num_turns restarts at 1 while modelUsage is cumulative. */
export const wrapUpResult = msg({
	type: 'result',
	subtype: 'success',
	num_turns: 1,
	total_cost_usd: 0.21266249999999998,
	usage: { input_tokens: 2, output_tokens: 133 },
	modelUsage: {
		'claude-sonnet-5': model({
			inputTokens: 6,
			outputTokens: 619,
			cacheReadInputTokens: 110085,
			cacheCreationInputTokens: 28389,
			costUSD: 0.21266249999999998,
		}),
	},
	stop_reason: 'end_turn',
	terminal_reason: 'completed',
	is_error: false,
	result: WRAP_UP_TEXT,
	session_id: SESSION,
});

/** A clean successful run's result. */
export const successResult = (over: Record<string, unknown> = {}) =>
	msg({
		type: 'result',
		subtype: 'success',
		num_turns: 2,
		total_cost_usd: 0.0412,
		duration_ms: 4821,
		usage: { input_tokens: 12, output_tokens: 47 },
		modelUsage: { 'claude-sonnet-5': model({ outputTokens: 47, costUSD: 0.0412 }) },
		stop_reason: 'end_turn',
		terminal_reason: 'completed',
		is_error: false,
		result: 'pong',
		session_id: SESSION,
		...over,
	});

/**
 * A result carrying an error subtype. Note it also carries a non-empty `errors` array — every
 * SDKResultError does. That is exactly why the text-format fallback ladder has to test the
 * subtype BEFORE the generic `errors.length` branch, or the specific recovery branches become
 * dead code.
 */
export const errorResult = (
	subtype:
		| 'error_max_turns'
		| 'error_during_execution'
		| 'error_max_budget_usd'
		| 'error_max_structured_output_retries',
	over: Record<string, unknown> = {},
) =>
	msg({
		type: 'result',
		subtype,
		num_turns: 8,
		total_cost_usd: 0.0917,
		duration_ms: 31204,
		usage: { input_tokens: 40, output_tokens: 512 },
		modelUsage: { 'claude-sonnet-5': model({ outputTokens: 512, costUSD: 0.0917 }) },
		is_error: true,
		errors: [`[sdk] ${subtype}`],
		session_id: SESSION,
		...over,
	});

/** A result with no `modelUsage` at all — what a hard abort leaves behind. */
export const bareResult = (over: Record<string, unknown> = {}) =>
	msg({
		type: 'result',
		subtype: 'error_during_execution',
		is_error: true,
		errors: ['aborted'],
		session_id: SESSION,
		...over,
	});

/** Named streams for the R1 output matrix. Each one is a complete run. */
export const streams = {
	/** Plain success with one tool call. */
	success: (): SDKMessage[] => [
		init({ tools: ['Bash', 'Read', 'Workflow'] }),
		assistantTool('Read'),
		userToolResult(),
		assistantText('pong'),
		successResult(),
	],
	/** Hit the turn ceiling. Has assistant text to recover, and an errors array. */
	maxTurns: (): SDKMessage[] => [
		init({ tools: ['Bash'] }),
		assistantTool('Bash'),
		assistantText('halfway through the refactor'),
		errorResult('error_max_turns'),
	],
	/** Hit the turn ceiling with nothing to recover. */
	maxTurnsNoText: (): SDKMessage[] => [
		init(),
		assistantTool('Bash'),
		errorResult('error_max_turns'),
	],
	/** Failed mid-execution, with assistant text to recover. */
	duringExecution: (): SDKMessage[] => [
		init(),
		assistantText('started reading the files'),
		errorResult('error_during_execution'),
	],
	/** An error subtype with no specific recovery branch — falls to the generic errors handler. */
	budgetExceeded: (): SDKMessage[] => [
		init(),
		assistantText('partial work'),
		errorResult('error_max_budget_usd'),
	],
	/** No result message at all: the run was cut off. Text must come from the transcript. */
	noResult: (): SDKMessage[] => [init(), assistantTool('Read'), assistantText('almost done')],
	/** Nothing but the init message — the degenerate case every builder must survive. */
	empty: (): SDKMessage[] => [init()],
	/** A graceful timeout: interrupt result, re-init, wrap-up turn, second result. */
	gracefulTimeout: (): SDKMessage[] => [
		init(),
		assistantTool('Read'),
		interruptResult,
		init(),
		assistantText(WRAP_UP_TEXT),
		wrapUpResult,
	],
	/** A graceful timeout whose wrap-up turn itself ran out of time: metrics, no summary. */
	wrapUpFailed: (): SDKMessage[] => [init(), assistantTool('Read'), interruptResult],
	/** A hard abort: a result arrived but carries no usage, so nothing is reliable. */
	hardAbort: (): SDKMessage[] => [init(), assistantTool('Read'), bareResult()],
	/** A hard abort with no result message whatsoever — the original zero-cost bug. */
	hardAbortNoResult: (): SDKMessage[] => [init(), assistantTool('Read')],
	/** Ultracode: the Workflow tool is available and both it and Task were used. */
	ultracode: (): SDKMessage[] => [
		init({ tools: ['Bash', 'Workflow', 'Task'] }),
		assistantThinking(),
		assistantTool('Workflow'),
		assistantTool('Task'),
		assistantText('orchestration complete'),
		successResult(),
	],
};

export type StreamName = keyof typeof streams;

export const STREAM_NAMES = Object.keys(streams) as StreamName[];
