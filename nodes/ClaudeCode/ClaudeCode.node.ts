import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createPromptStream } from './promptStream';
import { claudeCodeDescription } from './description/properties';
import { checkPrompt, readParams } from './params';
import { buildDiagnostics as collectDiagnostics } from './diagnostics';
import { buildOutputItem } from './output';
import { runQuery } from './runner';
import { createDebugLogger } from '../shared/debug';
import { buildQueryOptions } from './config';
import {
	buildTimeoutPayload,
	collectRunMetrics,
	formatTimeoutDescription,
	formatTimeoutMessage,
	shapeFailureJson,
	type TerminationReason,
} from './timeout';

/**
 * Indirection over the SDK's `query`, so a test can drive the message stream without spawning a
 * CLI. Temporary: runner.ts takes `query` as a parameter once the run loop is extracted (T13),
 * and this goes away with it.
 */
export const queryImpl = { query };

export class ClaudeCode implements INodeType {
	description: INodeTypeDescription = claudeCodeDescription;

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const nodeVersion = this.getNode().typeVersion;

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			let timeout = 300; // Default timeout
			let timedOut = false;
			let terminationReason: TerminationReason | null = null;
			// A graceful stop asks Claude to summarise. That turn can itself run out of time, in
			// which case the metrics still survive but the summary does not.
			let wrapUpSucceeded = false;

			const failureJson = (message: string, description: string | null, report: IDataObject) =>
				shapeFailureJson(nodeVersion, message, description, report) as IDataObject;
			// Declared per item and outside the try blocks so every error path can
			// still report what ran and what it cost.
			const messages: SDKMessage[] = [];
			let diagnostics: Record<string, unknown> | null = null;
			try {
				// One read of the node's parameters, into one typed object. Everything after this line
				// works on plain data — see params.ts.
				const params = readParams(this, itemIndex);
				const { outputFormat, additional: additionalOptions } = params;
				const rawPrompt = params.prompt;
				timeout = params.timeoutSeconds;

				// Validate required parameters before arming the timers, so a rejected
				// prompt cannot leak a pending timeout handle.
				const promptProblem = checkPrompt(rawPrompt);
				if (promptProblem) {
					throw new NodeOperationError(this.getNode(), promptProblem.message, { itemIndex });
				}

				// The timers are armed further down, once the query exists — the soft one calls
				// interrupt() on it.
				const abortController = new AbortController();

				// Stopping the n8n execution must also stop the agent. Without this the
				// spawned Claude Code process keeps running — and keeps spending — until
				// its own timeout, with its output discarded.
				this.onExecutionCancellation(() => abortController.abort());

				// Delivered as a stream, not a string: control requests such as interrupt() are only
				// available in streaming input mode. The stream must be closed once the run is done
				// or the SDK keeps the session open and the query never ends.
				const promptStream = createPromptStream(rawPrompt);

				// Capture the effort level Claude Code actually applies (post-downgrade). Written by a
				// hook that config.ts registers; read by diagnostics after the run.
				let appliedEffort: string | undefined;

				// Every SDK option is set by an ordered table of appliers — see config.ts. Validation
				// failures come back as a Problem rather than being thrown from inside, so that this is
				// the only place that needs `this.getNode()`.
				const outcome = buildQueryOptions(params, {
					abortController,
					promptStream,
					onEffort: (level) => {
						appliedEffort = level;
					},
				});
				if ('problem' in outcome) {
					throw new NodeOperationError(this.getNode(), outcome.problem.message, {
						itemIndex,
						...(outcome.problem.description ? { description: outcome.problem.description } : {}),
					});
				}
				const { queryOptions, graceWindow } = outcome.config;

				// Moved below the config build: it reports the grace window, which config.ts resolves.
				if (additionalOptions.debug) {
					this.logger.debug('Starting Claude Code execution', {
						itemIndex,
						prompt: rawPrompt.substring(0, 100) + '...',
						model: params.model,
						maxTurns: params.maxTurns,
						timeout: `${timeout}s`,
						nodeVersion,
						wrapUpGraceSeconds: graceWindow.graceSeconds,
						wrapUpAtMs: graceWindow.wrapUpAtMs,
						hardAbortAtMs: graceWindow.hardAbortAtMs,
						allowedTools: params.allowedTools,
						disallowedTools: params.disallowedTools,
						fallbackModel: additionalOptions.fallbackModel || 'none',
						appliedOptions: outcome.config.applied,
						...outcome.config.notes,
					});
				}

				// Execute query
				const includeTranscript = additionalOptions.includeTranscript !== false;
				const startTime = Date.now();

				// Diagnostics — verifiable proof of what actually ran. See diagnostics.ts.
				// A thunk, not a value: it is called on the success path and again from each catch,
				// against whatever messages had arrived by then.
				const buildDiagnostics = (): Record<string, unknown> =>
					collectDiagnostics({
						messages,
						params,
						permissionMode: queryOptions.options.permissionMode as string,
						appliedEffort: appliedEffort ?? null,
					}) as unknown as Record<string, unknown>;

				// One place builds the timeout report, so the thrown error, the continueOnFail item and
				// the text-format item cannot drift apart.
				const buildTimeoutError = (): NodeOperationError => {
					diagnostics = diagnostics ?? buildDiagnostics();
					const report = {
						metrics: collectRunMetrics(messages),
						terminationReason: terminationReason ?? ('timeout_hard_abort' as TerminationReason),
						timeoutSeconds: timeout,
						graceSeconds: graceWindow.graceSeconds,
						wrapUpSucceeded,
						durationMs: Date.now() - startTime,
						messageCount: messages.length,
						diagnostics,
					};

					const timeoutError = new NodeOperationError(
						this.getNode(),
						formatTimeoutMessage(report),
						{
							itemIndex,
							// The machine-readable tag n8n core nodes branch on — HttpRequestV3 reads
							// `error.type === 'invalid_url'` the same way.
							type: 'timeout',
							description: formatTimeoutDescription(report),
						},
					);

					// Saved with the execution and readable by an Error Workflow via
					// `execution.error.context`. The UI panel does not render it — hence the message
					// and description above carrying the numbers themselves.
					timeoutError.context = buildTimeoutPayload(report) as IDataObject;
					return timeoutError;
				};

				// The query, the two timers and the message loop live in runner.ts. It reports a timeout
				// rather than throwing one, which is what removes the nested try/catch/finally from here.
				const debugLog = createDebugLogger(this.logger, additionalOptions.debug === true);
				const run = await runQuery({
					queryOptions,
					graceWindow,
					promptStream,
					abortController,
					query: queryImpl.query,
					debug: debugLog,
					messages,
					getAppliedEffort: () => appliedEffort,
				});
				timedOut = run.timedOut;
				terminationReason = run.terminationReason;
				wrapUpSucceeded = run.wrapUpSucceeded;

				try {
					if (run.error !== null) throw run.error;

					// A graceful timeout ends the generator normally, so without this the run falls through
					// to the success path and reports green with the wrap-up as the answer.
					if (timedOut) throw buildTimeoutError();

					const duration = Date.now() - startTime;
					if (additionalOptions.debug) {
						this.logger.debug('Execution completed', {
							durationMs: duration,
							messageCount: messages.length,
						});

						// Log final messages array summary
						const messageTypes = messages.map((m) => ({
							type: m.type,
							subtype: (m as any).subtype,
						}));
						this.logger.debug('All messages in order', { messageTypes });
					}

					diagnostics = buildDiagnostics();
					if (additionalOptions.debug) {
						this.logger.debug('Run diagnostics', diagnostics);
					}

					// Format output based on selected format
					// The three output shapes live in output/ now. Versions 1 and 1.1 go to the frozen
					// legacy builders; 1.2 gets the unified envelope.
					const debug = additionalOptions.debug === true;
					if (debug) {
						const messageSummary = messages.reduce(
							(acc, msg) => {
								acc[msg.type] = (acc[msg.type] || 0) + 1;
								return acc;
							},
							{} as Record<string, number>,
						);
						this.logger.debug('Message summary', {
							messageSummary,
							totalMessages: messages.length,
							outputFormat,
						});
					}

					const outputData = buildOutputItem({
						nodeVersion,
						format: outputFormat,
						messages,
						diagnostics,
						includeTranscript,
					});

					if (debug) {
						try {
							JSON.stringify(outputData);
						} catch (e) {
							this.logger.error('Output data is not JSON-compatible', { error: e });
						}
					}

					returnData.push({
						json: outputData,
						pairedItem: { item: itemIndex },
					});
				} catch (queryError) {
					// The SDK delivers the result message before rejecting, so the spend
					// and session data are already in `messages` — report them instead of
					// claiming the run was free.
					const failedResult = messages.find((m) => m.type === 'result') as any;
					diagnostics = buildDiagnostics();

					// Report every timeout through the outer catch, so the shape is identical whether
					// the generator threw or ended cleanly after a wrap-up.
					if (timedOut) {
						throw queryError instanceof NodeOperationError ? queryError : buildTimeoutError();
					}

					// Only soften the failure when the workflow asked for it. Returning a
					// normal item unconditionally hid every failure behind a green
					// execution and bypassed n8n's error output.
					if (outputFormat === 'text' && this.continueOnFail()) {
						const errorMessage =
							queryError instanceof Error ? queryError.message : String(queryError);
						returnData.push({
							json: failureJson(errorMessage, null, {
								result: `Error during execution: ${errorMessage}`,
								success: false,
								errorType: timedOut ? 'timeout' : 'execution_error',
								duration_ms: failedResult?.duration_ms ?? Date.now() - startTime,
								// null, not 0 — an unknown cost is not a free run
								total_cost_usd: failedResult?.total_cost_usd ?? null,
								num_turns: failedResult?.num_turns ?? null,
								session_id: failedResult?.session_id ?? null,
								usage: failedResult?.usage ?? null,
								diagnostics,
							}),
							pairedItem: { item: itemIndex },
						});
					} else {
						throw queryError;
					}
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
				// The SDK's AbortError does not override `name`, so it reports as 'Error'.
				// Track the timeout ourselves instead of sniffing the error.
				const isTimeout = timedOut;
				// Built by buildTimeoutError, so it already carries the self-describing message, the
				// description and the full payload on `context`.
				const timeoutError =
					error instanceof NodeOperationError && error.type === 'timeout' ? error : null;

				if (this.continueOnFail()) {
					if (timeoutError) {
						returnData.push({
							json: failureJson(
								timeoutError.message,
								timeoutError.description ?? null,
								timeoutError.context as IDataObject,
							),
							pairedItem: { item: itemIndex },
						});
						continue;
					}

					const failedResult = messages.find((m) => m.type === 'result') as any;
					returnData.push({
						json: failureJson(errorMessage, null, {
							error: errorMessage,
							errorType: isTimeout ? 'timeout' : 'execution_error',
							errorDetails: error instanceof Error ? error.stack : undefined,
							itemIndex,
							// A failed run still costs money — surface what it spent.
							total_cost_usd: failedResult?.total_cost_usd ?? null,
							num_turns: failedResult?.num_turns ?? null,
							session_id: failedResult?.session_id ?? null,
							usage: failedResult?.usage ?? null,
							diagnostics,
						}),
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (timeoutError) throw timeoutError;

				// Provide more specific error messages
				const userFriendlyMessage = isTimeout
					? `Operation timed out after ${timeout} seconds. Consider increasing the timeout in Additional Options.`
					: `Claude Code execution failed: ${errorMessage}`;

				throw new NodeOperationError(this.getNode(), userFriendlyMessage, {
					itemIndex,
					description: errorMessage,
				});
			}
		}

		return [returnData];
	}
}
