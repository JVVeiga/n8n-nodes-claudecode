import type { IDataObject, INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	buildFailureItem,
	buildStructuredFailureItem,
	buildTimeoutFailureItem,
	buildTimeoutReport,
	userFacingMessage,
	type FailureContext,
} from './errors';
import type { TerminationReason } from './timeout';

/**
 * Which failure path an item takes. Each `settle*` function returns the path as a `Settled`, and
 * `settle` turns it into the item's json or the thrown `NodeOperationError`.
 */

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
