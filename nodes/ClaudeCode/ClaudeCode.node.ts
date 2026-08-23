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
 * Indirection over the SDK's `query`, so a test can drive the message stream without spawning a
 * CLI. runner.ts takes `query` as a parameter; this is where the real one comes from, and swapping
 * it is how tests/helpers/fakeQuery.ts works.
 */
export const queryImpl = { query };

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
 * execute() is the wiring plus the two things that genuinely need `this`: constructing
 * NodeOperationErrors (they need getNode()) and pushing items.
 */
export class ClaudeCode implements INodeType {
	description: INodeTypeDescription = claudeCodeDescription;

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const nodeVersion = this.getNode().typeVersion;

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			// Declared per item and outside the try so every error path can still report what ran and
			// what it cost. The array is handed to runQuery, which pushes into it as messages arrive.
			const messages: SDKMessage[] = [];
			let timeoutSeconds = 300;
			let timedOut = false;

			const fail = (message: string, description?: string, type?: string) =>
				new NodeOperationError(this.getNode(), message, {
					itemIndex,
					...(description ? { description } : {}),
					...(type ? { type } : {}),
				});

			try {
				const params = readParams(this, itemIndex);
				timeoutSeconds = params.timeoutSeconds;
				const debug = createDebugLogger(this.logger, params.additional.debug === true);

				const promptProblem = checkPrompt(params.prompt);
				if (promptProblem) throw fail(promptProblem.message, promptProblem.description);

				// The timers are armed inside runQuery, so a rejected prompt cannot leak a pending
				// handle.
				const abortController = new AbortController();
				// Stopping the n8n execution must also stop the agent. Without this the spawned Claude
				// Code process keeps running — and keeps spending — until its own timeout, with its
				// output discarded.
				this.onExecutionCancellation(() => abortController.abort());

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
					query: queryImpl.query,
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

				const ctx: FailureContext = {
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
					const report = buildTimeoutReport(ctx, run, graceWindow.graceSeconds);
					if (this.continueOnFail()) {
						returnData.push({
							json: buildTimeoutFailureItem(ctx, report),
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
					if (this.continueOnFail()) {
						returnData.push({
							json:
								params.outputFormat === 'text'
									? buildTextFailureItem(ctx, errorMessage)
									: buildFailureItem(ctx, errorMessage, {
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
				if (error instanceof NodeOperationError && !this.continueOnFail()) throw error;

				const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';

				if (this.continueOnFail()) {
					const ctx: FailureContext = {
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
							? buildTimeoutFailureItem(ctx, {
									message: timeoutError.message,
									description: timeoutError.description ?? '',
									context: timeoutError.context as never,
								})
							: buildFailureItem(ctx, errorMessage, {
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
}
