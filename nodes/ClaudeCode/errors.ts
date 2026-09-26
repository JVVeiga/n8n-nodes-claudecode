import type { IDataObject, INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { findResult } from '../shared/sdkMessage';
import { buildRunMetrics } from './output/metrics';
import {
	buildTimeoutPayload,
	collectRunMetrics,
	formatTimeoutDescription,
	formatTimeoutMessage,
	shapeFailureJson,
	type TerminationReason,
} from './timeout';

/**
 * The failure paths, as data.
 *
 * A run can end four ways, and getting any of them wrong is expensive:
 *
 *   1. thrown `NodeOperationError`      — the default; stops the workflow
 *   2. inner continueOnFail (text only) — a soft failure item, historically the only one
 *   3. outer continueOnFail             — a soft failure item for everything else
 *   4. timeout                          — routed through (1) or (3), never its own shape
 *
 * The pieces are built here so the thrown error, the soft item and the timeout report cannot drift
 * apart, and so each can be asserted without a node instance. The `settle*` functions decide which
 * path an item takes and return it as a `Settled`; `settle` turns that into the item's json or the
 * thrown `NodeOperationError`, which needs the node from the execution context.
 */

/** Everything a failure needs to report, whatever path it takes. */
export type FailureContext = {
	messages: SDKMessage[];
	diagnostics: Record<string, unknown> | null;
	nodeVersion: number;
	itemIndex: number;
	timeoutSeconds: number;
	durationMs: number;
};

type ResultLike = {
	duration_ms?: number;
	total_cost_usd?: number;
	num_turns?: number;
	session_id?: string;
	usage?: unknown;
};

/**
 * The spend the SDK already reported before it failed.
 *
 * Every field is `?? null`, never `?? 0`: an unknown cost is not a free run, and reporting zero
 * made timed-out runs look free. The SDK delivers its result message BEFORE rejecting, so this is
 * usually populated even on the error path.
 */
const spendOf = (messages: SDKMessage[]) => {
	const result = findResult(messages) as ResultLike | undefined;
	return {
		total_cost_usd: result?.total_cost_usd ?? null,
		num_turns: result?.num_turns ?? null,
		session_id: result?.session_id ?? null,
		usage: result?.usage ?? null,
		durationMs: result?.duration_ms ?? null,
	};
};

export type TimeoutReport = {
	message: string;
	description: string;
	/** Goes on `error.context`, saved with the execution and readable by an Error Workflow. */
	context: IDataObject;
};

/**
 * One place builds the timeout report, so the thrown error and the soft item cannot disagree about
 * what happened.
 *
 * The message and description carry the numbers themselves because n8n's UI panel does not render
 * `error.context` — only an Error Workflow reading `execution.error.context` sees that.
 */
export function buildTimeoutReport(
	ctx: FailureContext,
	run: { terminationReason: TerminationReason | null; wrapUpSucceeded: boolean },
	graceSeconds: number,
): TimeoutReport {
	const report = {
		metrics: collectRunMetrics(ctx.messages),
		// A hard abort is the honest default: it means no soft stop was recorded.
		terminationReason: run.terminationReason ?? ('timeout_hard_abort' as TerminationReason),
		timeoutSeconds: ctx.timeoutSeconds,
		graceSeconds,
		wrapUpSucceeded: run.wrapUpSucceeded,
		durationMs: ctx.durationMs,
		messageCount: ctx.messages.length,
		diagnostics: ctx.diagnostics,
	};

	return {
		message: formatTimeoutMessage(report),
		description: formatTimeoutDescription(report),
		context: buildTimeoutPayload(report) as IDataObject,
	};
}

/** The `text`-format soft failure item — path 2. */
export function buildTextFailureItem(ctx: FailureContext, errorMessage: string): IDataObject {
	const spend = spendOf(ctx.messages);
	return shapeFailureJson(ctx.nodeVersion, errorMessage, null, {
		result: `Error during execution: ${errorMessage}`,
		success: false,
		errorType: 'execution_error',
		duration_ms: spend.durationMs ?? ctx.durationMs,
		total_cost_usd: spend.total_cost_usd,
		num_turns: spend.num_turns,
		session_id: spend.session_id,
		usage: spend.usage,
		diagnostics: ctx.diagnostics,
	}) as IDataObject;
}

/** The general soft failure item — path 3. */
export function buildFailureItem(
	ctx: FailureContext,
	errorMessage: string,
	options: { isTimeout: boolean; stack?: string },
): IDataObject {
	const spend = spendOf(ctx.messages);
	return shapeFailureJson(ctx.nodeVersion, errorMessage, null, {
		error: errorMessage,
		errorType: options.isTimeout ? 'timeout' : 'execution_error',
		errorDetails: options.stack,
		itemIndex: ctx.itemIndex,
		// A failed run still costs money — surface what it spent.
		total_cost_usd: spend.total_cost_usd,
		num_turns: spend.num_turns,
		session_id: spend.session_id,
		usage: spend.usage,
		diagnostics: ctx.diagnostics,
	}) as IDataObject;
}

/**
 * The soft failure item for a run that finished but did not deliver the structured object it was
 * asked for. It carries the run's metrics, because the run was paid for either way.
 */
export function buildStructuredFailureItem(ctx: FailureContext, errorMessage: string): IDataObject {
	return shapeFailureJson(ctx.nodeVersion, errorMessage, null, {
		error: errorMessage,
		errorType: 'structured_output',
		itemIndex: ctx.itemIndex,
		metrics: buildRunMetrics(ctx.messages, ctx.durationMs),
		diagnostics: ctx.diagnostics,
	}) as IDataObject;
}

/** A run that finished without the structured object it was asked for. */
export function settleStructuredFailure(
	ctx: FailureContext,
	reason: string,
	continueOnFail: () => boolean,
): Settled {
	const message = `Claude Code did not return the structured output: ${reason}`;
	if (continueOnFail()) return { json: buildStructuredFailureItem(ctx, message) };
	return {
		error: {
			message,
			description:
				'The run finished without an object matching the schema. diagnostics.structuredOutput.attempts counts its tries; a clearer schema or prompt usually helps.',
			type: 'structured_output',
		},
	};
}

/** The soft failure item for a timeout — path 4 folded into path 3. */
export function buildTimeoutFailureItem(
	ctx: FailureContext,
	report: { message: string; description: string; context: IDataObject },
): IDataObject {
	return shapeFailureJson(
		ctx.nodeVersion,
		report.message,
		report.description,
		report.context,
	) as IDataObject;
}

/** An error the node throws: `type` and `context` are set on the NodeOperationError. */
export type ThrownFailure = {
	message: string;
	description?: string;
	type?: string;
	context?: IDataObject;
};

/** What a failed item becomes: a soft item under Continue On Fail, otherwise an error. */
export type Settled = { json: IDataObject } | { error: ThrownFailure } | { rethrow: unknown };

export type ItemFailer = (
	message: string,
	description?: string,
	type?: string,
) => NodeOperationError;

export const itemFailer =
	(ctx: { getNode(): INode }, itemIndex: number): ItemFailer =>
	(message, description, type) =>
		new NodeOperationError(ctx.getNode(), message, {
			itemIndex,
			...(description ? { description } : {}),
			...(type ? { type } : {}),
		});

/** The item's json when it settled soft; throws otherwise. */
export function settle(settled: Settled, fail: ItemFailer): IDataObject {
	if ('json' in settled) return settled.json;
	if ('rethrow' in settled) throw settled.rethrow;
	const { message, description, type, context } = settled.error;
	const error = fail(message, description, type);
	if (context) error.context = context;
	throw error;
}

/**
 * A finished run that timed out or reported an error, or null when it did neither.
 * `errorItem` replaces the general soft item for a run error.
 */
export function settleRun(
	ctx: FailureContext,
	run: {
		timedOut: boolean;
		terminationReason: TerminationReason | null;
		wrapUpSucceeded: boolean;
		error: unknown;
	},
	graceSeconds: number,
	continueOnFail: () => boolean,
	errorItem?: (errorMessage: string) => IDataObject,
): Settled | null {
	// A graceful timeout ends the generator normally, so without this an expired run would
	// fall through to the success path and report green with the wrap-up as its answer.
	if (run.timedOut) {
		const report = buildTimeoutReport(ctx, run, graceSeconds);
		if (continueOnFail()) return { json: buildTimeoutFailureItem(ctx, report) };
		// `type: 'timeout'` is the machine-readable tag n8n core nodes branch on —
		// HttpRequestV3 reads `error.type === 'invalid_url'` the same way.
		return {
			error: {
				message: report.message,
				description: report.description,
				type: 'timeout',
				context: report.context,
			},
		};
	}

	if (run.error === null) return null;
	const errorMessage = run.error instanceof Error ? run.error.message : String(run.error);
	// Only soften the failure when the workflow asked for it. Returning a normal item
	// unconditionally hid every failure behind a green execution and bypassed n8n's
	// error output.
	if (continueOnFail()) {
		return {
			json: errorItem
				? errorItem(errorMessage)
				: buildFailureItem(ctx, errorMessage, {
						isTimeout: false,
						stack: run.error instanceof Error ? run.error.stack : undefined,
					}),
		};
	}
	return {
		error: {
			message: userFacingMessage(errorMessage, false, ctx.timeoutSeconds),
			description: errorMessage,
		},
	};
}

/**
 * Whatever reached the node's catch: a validation failure, a config problem, or a timeout or run
 * error thrown by `settle`. A NodeOperationError is already shaped correctly.
 */
export function settleCaught(
	ctx: FailureContext,
	error: unknown,
	continueOnFail: () => boolean,
	isTimeout: boolean,
): Settled {
	if (error instanceof NodeOperationError && !continueOnFail()) return { rethrow: error };

	const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
	if (continueOnFail()) {
		// A timeout thrown above already carries its full report on `context`.
		const timeoutError =
			error instanceof NodeOperationError && error.type === 'timeout' ? error : null;
		return {
			json: timeoutError
				? buildTimeoutFailureItem(ctx, {
						message: timeoutError.message,
						description: timeoutError.description ?? '',
						context: timeoutError.context as never,
					})
				: buildFailureItem(ctx, errorMessage, {
						isTimeout,
						stack: error instanceof Error ? error.stack : undefined,
					}),
		};
	}
	return {
		error: {
			message: userFacingMessage(errorMessage, isTimeout, ctx.timeoutSeconds),
			description: errorMessage,
		},
	};
}

/**
 * The message shown when a run failed and the workflow did not ask for a soft failure.
 *
 * The SDK's AbortError does not override `name`, so it reports as a plain 'Error'. The timeout is
 * tracked explicitly rather than sniffed out of the error.
 */
export const userFacingMessage = (
	errorMessage: string,
	isTimeout: boolean,
	timeoutSeconds: number,
) =>
	isTimeout
		? `Operation timed out after ${timeoutSeconds} seconds. Consider increasing the timeout in Additional Options.`
		: `Claude Code execution failed: ${errorMessage}`;
