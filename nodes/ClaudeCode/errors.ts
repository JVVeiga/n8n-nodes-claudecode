import type { IDataObject } from 'n8n-workflow';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { findResult } from '../shared/sdkMessage';
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
 * apart, and so each can be asserted without a node instance. The node turns a `TimeoutError`
 * descriptor into a real `NodeOperationError`, because that needs `this.getNode()`.
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
