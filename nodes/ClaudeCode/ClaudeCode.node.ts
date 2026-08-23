import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createDebugLogger } from '../shared/debug';
import { buildQueryOptions } from './config';
import { claudeCodeDescription } from './description/properties';
import { buildDiagnostics } from './diagnostics';
import {
	buildFailureItem,
	buildTextFailureItem,
	buildTimeoutFailureItem,
	buildTimeoutReport,
	userFacingMessage,
	type FailureContext,
} from './errors';
import { buildOutputItem } from './output';
import { checkPrompt, readParams } from './params';
import { createPromptStream } from './promptStream';
import { runQuery } from './runner';

/**
 * The node is a thin shell now. Everything it does lives in a named module:
 *
 *   params.ts       reads IExecuteFunctions          — the only place that does
 *   config.ts       node parameters  -> SDK options  — an ordered table of appliers
 *   runner.ts       runs the query, owns the timers  — reports a timeout, never throws one
 *   diagnostics.ts  evidence of what actually ran
 *   output/         the item shape, per typeVersion   — legacy.ts is frozen
 *   errors.ts       the four failure paths, as data
 *
 * The work is in `runItems`, an exported function taking its dependencies as an argument, and
 * `execute()` is a one-line adapter onto it.
 *
 * That split exists because n8n calls `execute` as `execute.call(executionContext)` — `this` is the
 * execution context, NOT the node instance — so a node cannot be constructor-injected and instance
 * fields are unreachable from inside execute(). Without `runItems`, the only seam left is a mutable
 * module-level binding that tests swap at runtime, which is a worse thing to own than a parameter.
 */
export type ExecuteDeps = {
	/** The SDK's `query`. Injected so a test drives the message stream without spawning a CLI. */
	query: typeof query;
};

export class ClaudeCode implements INodeType {
	description: INodeTypeDescription = claudeCodeDescription;

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return runItems(this, { query });
	}
}

export async function runItems(
	ctx: IExecuteFunctions,
	deps: ExecuteDeps,
): Promise<INodeExecutionData[][]> {
	const items = ctx.getInputData();
	const returnData: INodeExecutionData[] = [];
	const nodeVersion = ctx.getNode().typeVersion;

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		// Declared per item and outside the try so every error path can still report what ran and
		// what it cost. The array is handed to runQuery, which pushes into it as messages arrive.
		const messages: SDKMessage[] = [];
		let timeoutSeconds = 300;
		let timedOut = false;

		const fail = (message: string, description?: string, type?: string) =>
			new NodeOperationError(ctx.getNode(), message, {
				itemIndex,
				...(description ? { description } : {}),
				...(type ? { type } : {}),
			});

		try {
			const params = readParams(ctx, itemIndex);
			timeoutSeconds = params.timeoutSeconds;
			const debug = createDebugLogger(ctx.logger, params.additional.debug === true);

			const promptProblem = checkPrompt(params.prompt);
			if (promptProblem) throw fail(promptProblem.message, promptProblem.description);

			// The timers are armed inside runQuery, so a rejected prompt cannot leak a pending
			// handle.
			const abortController = new AbortController();
			// Stopping the n8n execution must also stop the agent. Without this the spawned Claude
			// Code process keeps running — and keeps spending — until its own timeout, with its
			// output discarded.
			ctx.onExecutionCancellation(() => abortController.abort());

			// A stream, not a string: control requests such as interrupt() only exist in streaming
			// input mode, and interrupt() is what makes a timed-out run report its real cost.
			const promptStream = createPromptStream(params.prompt);

			let appliedEffort: string | undefined;
			const outcome = buildQueryOptions(params, {
				abortController,
				promptStream,
				onEffort: (level) => {
					appliedEffort = level;
				},
			});
			if ('problem' in outcome) {
				throw fail(outcome.problem.message, outcome.problem.description);
			}
			const { queryOptions, graceWindow } = outcome.config;

			debug.log('Starting Claude Code execution', {
				itemIndex,
				prompt: params.prompt.substring(0, 100) + '...',
				model: params.model,
				maxTurns: params.maxTurns,
				timeout: `${timeoutSeconds}s`,
				nodeVersion,
				wrapUpGraceSeconds: graceWindow.graceSeconds,
				wrapUpAtMs: graceWindow.wrapUpAtMs,
				hardAbortAtMs: graceWindow.hardAbortAtMs,
				allowedTools: params.allowedTools,
				disallowedTools: params.disallowedTools,
				fallbackModel: params.additional.fallbackModel || 'none',
				appliedOptions: outcome.config.applied,
				...outcome.config.notes,
			});

			const run = await runQuery({
				queryOptions,
				graceWindow,
				promptStream,
				abortController,
				query: deps.query,
				debug,
				messages,
				getAppliedEffort: () => appliedEffort,
			});
			timedOut = run.timedOut;

			const diagnostics = buildDiagnostics({
				messages,
				params,
				permissionMode: queryOptions.options.permissionMode as string,
				appliedEffort: run.appliedEffort,
			}) as unknown as Record<string, unknown>;

			const failure: FailureContext = {
				messages,
				diagnostics,
				nodeVersion,
				itemIndex,
				timeoutSeconds,
				durationMs: run.durationMs,
			};

			// A graceful timeout ends the generator normally, so without this an expired run would
			// fall through to the success path and report green with the wrap-up as its answer.
			if (timedOut) {
				const report = buildTimeoutReport(failure, run, graceWindow.graceSeconds);
				if (ctx.continueOnFail()) {
					returnData.push({
						json: buildTimeoutFailureItem(failure, report),
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				// `type: 'timeout'` is the machine-readable tag n8n core nodes branch on —
				// HttpRequestV3 reads `error.type === 'invalid_url'` the same way.
				const error = fail(report.message, report.description, 'timeout');
				error.context = report.context;
				throw error;
			}

			if (run.error !== null) {
				const errorMessage = run.error instanceof Error ? run.error.message : String(run.error);

				// Only soften the failure when the workflow asked for it. Returning a normal item
				// unconditionally hid every failure behind a green execution and bypassed n8n's
				// error output. `text` keeps its own shape for backwards compatibility.
				if (ctx.continueOnFail()) {
					returnData.push({
						json:
							params.outputFormat === 'text'
								? buildTextFailureItem(failure, errorMessage)
								: buildFailureItem(failure, errorMessage, {
										isTimeout: false,
										stack: run.error instanceof Error ? run.error.stack : undefined,
									}),
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw fail(userFacingMessage(errorMessage, false, timeoutSeconds), errorMessage);
			}

			debug.lazy('Execution completed', () => ({
				durationMs: run.durationMs,
				messageCount: messages.length,
				messageTypes: messages.map((m) => ({
					type: m.type,
					subtype: (m as { subtype?: string }).subtype,
				})),
				diagnostics,
			}));

			const outputData = buildOutputItem({
				nodeVersion,
				format: params.outputFormat,
				messages,
				diagnostics,
				includeTranscript: params.additional.includeTranscript !== false,
			});

			returnData.push({ json: outputData, pairedItem: { item: itemIndex } });
		} catch (error) {
			// Reached by: a validation failure, a config problem, a timeout thrown above, or a run
			// error thrown above. A NodeOperationError from here is already shaped correctly.
			if (error instanceof NodeOperationError && !ctx.continueOnFail()) throw error;

			const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';

			if (ctx.continueOnFail()) {
				const failure: FailureContext = {
					messages,
					diagnostics: null,
					nodeVersion,
					itemIndex,
					timeoutSeconds,
					durationMs: 0,
				};
				// A timeout thrown above already carries its full report on `context`.
				const timeoutError =
					error instanceof NodeOperationError && error.type === 'timeout' ? error : null;
				returnData.push({
					json: timeoutError
						? buildTimeoutFailureItem(failure, {
								message: timeoutError.message,
								description: timeoutError.description ?? '',
								context: timeoutError.context as never,
							})
						: buildFailureItem(failure, errorMessage, {
								isTimeout: timedOut,
								stack: error instanceof Error ? error.stack : undefined,
							}),
					pairedItem: { item: itemIndex },
				});
				continue;
			}

			throw fail(userFacingMessage(errorMessage, timedOut, timeoutSeconds), errorMessage);
		}
	}

	return [returnData];
}
