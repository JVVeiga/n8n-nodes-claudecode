import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { query, type OutputFormat, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AuthMode } from '../shared/auth';
import { createDebugLogger, type DebugLogger } from '../shared/debug';
import { checkProjectPath } from '../shared/projectPath';
import { findInit, lastResult } from '../shared/sdkMessage';
import { readAuth } from '../shared/readAuth';
import { readRunIndex, usageReporting } from '../shared/reportUsage';
import {
	runWithSession,
	toSessionUuid,
	type SessionAttempt,
	type SessionRequest,
	type SessionRun,
} from '../shared/session';
import type { SuppliedSubagent } from '../shared/subagent';
import { buildToolBridge } from '../shared/toolBridge';
import { createSequence, reportRun, type UsageReporting } from '../shared/usageReport';
import { prepareAttachments } from '../ClaudeCode/attachments/prepare';
import type { StagedAttachments } from '../ClaudeCode/attachments/types';
import { buildQueryOptions } from '../ClaudeCode/config';
import { buildRunMetrics } from '../ClaudeCode/output/metrics';
import {
	itemFailer,
	settle,
	settleCaught,
	settleRun,
	settleStructuredFailure,
	type FailureContext,
} from '../ClaudeCode/errors';
import { checkPrompt } from '../ClaudeCode/params';
import { createPromptStream, type PromptContent } from '../ClaudeCode/promptStream';
import { runQuery } from '../ClaudeCode/runner';
import type { ClaudeCodeParams, RunOutcome } from '../ClaudeCode/types';
import { checkToolNames, readConnections } from './connections';
import { claudeCodeAgentDescription } from './description';
import { readInstructions } from './instructions';
import { orchestrationInstruction } from './orchestration';
import { buildAgentDiagnostics, buildAgentOutput } from './output';
import { resolveOutputSchema } from './outputSchema';
import { readAgentParams } from './params';
import { extractStructured } from './structured';
import { buildSubagentReport, subagentInvocations } from './subagentReport';
import { buildSubagents } from './subagents';
import { combineVerificationMetrics } from './verification/metrics';
import { verifyStructured } from './verification/run';
import { checkVerification } from './verification/select';

export type AgentExecuteDeps = {
	/** The SDK's `query`. Injected so a test drives the message stream without spawning a CLI. */
	query: typeof query;
};

/** errors.ts shapes failures by node version; from 1.1 they are the shape n8n's error output
 * expects, which is the only shape this node has ever had. */
const FAILURE_SHAPE_VERSION = 1.1;

type Attempt = SessionAttempt & {
	run: RunOutcome;
	params: ClaudeCodeParams;
	graceSeconds: number;
	permissionMode: string;
};

export class ClaudeCodeAgent implements INodeType {
	description: INodeTypeDescription = claudeCodeAgentDescription;

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return runAgentItems(this, { query });
	}
}

export async function runAgentItems(
	ctx: IExecuteFunctions,
	deps: AgentExecuteDeps,
): Promise<INodeExecutionData[][]> {
	const items = ctx.getInputData();
	const returnData: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		let messages: SDKMessage[] = [];
		let timeoutSeconds = 300;
		let durationMs = 0;
		let diagnostics: Record<string, unknown> | null = null;
		let staged: StagedAttachments | null = null;
		const attempts: Attempt[] = [];
		let reporting: { usage: UsageReporting; authMode: AuthMode; debug: DebugLogger } | null = null;
		// Set only when a verification run happened: the item's one report then carries both runs.
		let verifiedMetrics: IDataObject | null = null;

		const fail = itemFailer(ctx, itemIndex);

		try {
			const { run: params, agent } = readAgentParams(ctx, itemIndex);
			timeoutSeconds = params.timeoutSeconds;
			const debug = createDebugLogger(ctx.logger, params.additional.debug === true);

			const promptProblem = checkPrompt(params.prompt);
			if (promptProblem) throw fail(promptProblem.message, promptProblem.description);

			const resume = agent.session.mode === 'resume';
			if (resume && agent.session.key === '') {
				throw fail(
					'Session is set to Resume, but Session ID or Key is empty',
					'Put a stable key for the conversation in Session ID or Key — a ticket, chat or user id, e.g. {{ $json.ticketId }} — or set Session to New.',
				);
			}
			const sessionUuid = resume ? toSessionUuid(agent.session.key) : null;

			const authOutcome = await readAuth(ctx, itemIndex);
			if ('problem' in authOutcome) {
				throw fail(authOutcome.problem.message, authOutcome.problem.description);
			}
			const auth = authOutcome.auth;

			// Everything that can refuse the item does so here, before a file is staged or a
			// process spawned.
			const connections = await readConnections(ctx, itemIndex);
			const toolNameProblem = checkToolNames(connections.tools);
			if (toolNameProblem) throw fail(toolNameProblem.message, toolNameProblem.description);
			const subagents = buildSubagents(connections.subagents);
			if ('problem' in subagents) {
				throw fail(subagents.problem.message, subagents.problem.description);
			}
			const subagentNames = Object.keys(subagents.agents);

			const schema = resolveOutputSchema(
				agent.outputMode,
				agent.jsonSchemaText,
				connections.parser,
			);
			if (schema && 'problem' in schema) {
				throw fail(schema.problem.message, schema.problem.description);
			}
			const verificationProblem = checkVerification(agent.verification, agent.outputMode);
			if (verificationProblem) {
				throw fail(verificationProblem.message, verificationProblem.description);
			}

			const pathProblem = checkProjectPath(params.projectPath);
			if (pathProblem) throw fail(pathProblem.message, pathProblem.description);

			const instructions =
				agent.instructionFiles.length > 0
					? readInstructions(params.projectPath, agent.instructionFiles)
					: null;
			if (instructions && 'problem' in instructions) {
				throw fail(instructions.problem.message, instructions.problem.description);
			}

			const abortController = new AbortController();
			ctx.onExecutionCancellation(() => abortController.abort());

			const orchestration =
				agent.orchestration === 'required' ? orchestrationInstruction(subagentNames) : null;
			const prepared = await prepareAttachments(
				ctx,
				itemIndex,
				params.attachments,
				params.prompt,
				orchestration ? [orchestration] : [],
			);
			if ('problem' in prepared) {
				throw fail(prepared.problem.message, prepared.problem.description);
			}
			staged = prepared.staged;
			const { plan, promptContent } = prepared;

			const bridge = buildToolBridge(connections.tools, (toolName, error) =>
				debug.error(`Bridged tool failed: ${toolName}`, {
					error: error instanceof Error ? error.message : String(error),
				}),
			);

			const usage = usageReporting(ctx, agent, debug, createSequence(), itemIndex);
			if (usage) {
				reporting = {
					usage: {
						...usage,
						context: { ...usage.context, runIndex: readRunIndex(ctx, itemIndex) },
					},
					authMode: auth.mode,
					debug,
				};
			}

			let appliedEffort: string | undefined;
			const mainFormat: OutputFormat | undefined = schema
				? { type: 'json_schema', schema: schema.schema }
				: undefined;

			const runTurn = async (
				session: SessionRequest,
				budget: { timeoutSeconds: number },
				turn: {
					content: PromptContent;
					outputFormat: OutputFormat | undefined;
					label: string;
					forkSession?: boolean;
				},
				sdkMessages: SDKMessage[],
			): Promise<Attempt> => {
				// Each attempt needs its own stream: the previous one was closed by its run.
				const promptStream = createPromptStream(turn.content);
				const budgeted: ClaudeCodeParams = { ...params, timeoutSeconds: budget.timeoutSeconds };
				const runParams: ClaudeCodeParams =
					session && 'resume' in session
						? { ...budgeted, operation: 'continue', sessionId: session.resume }
						: budgeted;
				const outcome = buildQueryOptions(runParams, {
					abortController,
					promptStream,
					stagedDir: staged?.dir,
					auth,
					onEffort: (level) => {
						appliedEffort = level;
					},
					mcp: bridge ?? undefined,
					agents: subagents.agents,
					outputFormat: turn.outputFormat,
					instructionsAppend: instructions?.append,
					claudeAiConnectors: agent.allowConnectors ? undefined : false,
					newSessionId: session && 'create' in session ? session.create : undefined,
					forkSession: turn.forkSession,
				});
				if ('problem' in outcome) {
					throw fail(outcome.problem.message, outcome.problem.description);
				}
				const { queryOptions, graceWindow } = outcome.config;

				debug.log(turn.label, {
					itemIndex,
					prompt: params.prompt.substring(0, 100) + '...',
					model: params.model,
					maxTurns: params.maxTurns,
					timeout: `${budget.timeoutSeconds}s`,
					session: session ?? 'new',
					subagents: subagentNames,
					bridgedTools: bridge?.toolNames ?? [],
					outputMode: agent.outputMode,
					appliedOptions: outcome.config.applied,
					...plan.notes,
					...outcome.config.notes,
				});

				const run = await runQuery({
					queryOptions,
					graceWindow,
					promptStream,
					abortController,
					query: deps.query,
					debug,
					messages: sdkMessages,
					getAppliedEffort: () => appliedEffort,
					pendingTasksKeepRunOpen: true,
				});
				return {
					run,
					sdkMessages,
					params: runParams,
					graceSeconds: graceWindow.graceSeconds,
					permissionMode: queryOptions.options.permissionMode as string,
				};
			};

			const runOnce = async (
				session: SessionRequest,
				budget: { timeoutSeconds: number },
			): Promise<Attempt> => {
				const sdkMessages: SDKMessage[] = [];
				messages = sdkMessages;
				const attempt = await runTurn(
					session,
					budget,
					{
						content: promptContent,
						outputFormat: mainFormat,
						label: 'Starting Claude Code Agent execution',
					},
					sdkMessages,
				);
				attempts.push(attempt);
				return attempt;
			};

			const session: SessionRun<Attempt> = sessionUuid
				? await runWithSession(runOnce, { sessionUuid, timeoutSeconds, debug })
				: {
						attempt: await runOnce(null, { timeoutSeconds }),
						state: 'new',
						unrecoverable: false,
					};
			const { run } = session.attempt;
			messages = session.attempt.sdkMessages;
			durationMs = run.durationMs;

			logSubagentInvocations(subagents.supplied, attempts, debug);

			const structuredOutcome = schema ? extractStructured(messages) : null;
			diagnostics = buildAgentDiagnostics({
				messages,
				params: session.attempt.params,
				permissionMode: session.attempt.permissionMode,
				appliedEffort: run.appliedEffort,
				attachments: plan.report,
				authMode: auth.mode,
				extra: {
					bridgedTools: bridge?.toolNames,
					subagents:
						subagentNames.length > 0 ? buildSubagentReport(messages, subagentNames) : undefined,
					instructions: instructions
						? { loaded: instructions.loaded, missing: instructions.missing }
						: undefined,
					structuredOutput: structuredOutcome
						? { mode: agent.outputMode, attempts: structuredOutcome.attempts }
						: undefined,
					sessionState: sessionUuid ? session.state : undefined,
				},
			});

			const failure: FailureContext = {
				messages,
				diagnostics,
				nodeVersion: FAILURE_SHAPE_VERSION,
				itemIndex,
				timeoutSeconds,
				durationMs,
			};

			// The SDK rejects right after yielding an exhausted-retries result; that rejection only
			// repeats the result, which is reported below as the structured failure it is.
			const structuredExhausted =
				structuredOutcome !== null &&
				'failure' in structuredOutcome &&
				lastResult(messages)?.subtype === 'error_max_structured_output_retries';
			const runError = session.unrecoverable
				? new Error(
						`Claude Code could neither resume nor create the session for "${agent.session.key}" ` +
							`(${sessionUuid}). Check the container's disk and the debug log, or set Session to New.`,
					)
				: structuredExhausted
					? null
					: run.error;
			const settled = settleRun(
				failure,
				{ ...run, error: runError },
				session.attempt.graceSeconds,
				() => ctx.continueOnFail(),
			);
			if (settled) {
				returnData.push({ json: settle(settled, fail), pairedItem: { item: itemIndex } });
				continue;
			}

			if (structuredOutcome && 'failure' in structuredOutcome) {
				const settled = settleStructuredFailure(failure, structuredOutcome.failure, () =>
					ctx.continueOnFail(),
				);
				returnData.push({ json: settle(settled, fail), pairedItem: { item: itemIndex } });
				continue;
			}

			let structured =
				structuredOutcome && 'ok' in structuredOutcome ? structuredOutcome.ok : undefined;
			let verification: IDataObject | undefined;
			if (agent.verification && structured !== undefined) {
				const verified = await verifyStructured({
					verification: agent.verification,
					structured,
					sessionId: lastResult(messages)?.session_id ?? findInit(messages)?.session_id ?? null,
					timeoutSeconds: params.timeoutSeconds,
					runTurn: (turn) =>
						runTurn(
							{ resume: turn.resume },
							{ timeoutSeconds: params.timeoutSeconds },
							{
								content: turn.content,
								outputFormat: turn.outputFormat,
								label: 'Starting Claude Code Agent verification run',
								// A fork, so the next execution with this Session Key continues after the
								// main run's answer, not after the verifier's turn.
								forkSession: true,
							},
							[],
						),
				});
				structured = verified.structured;
				let costUsd: number | null = 0;
				if (verified.attempt) {
					logSubagentInvocations(subagents.supplied, [verified.attempt], debug);
					const combined = combineVerificationMetrics(
						buildRunMetrics(messages, durationMs),
						buildRunMetrics(verified.attempt.sdkMessages, verified.attempt.run.durationMs),
					);
					verifiedMetrics = combined.metrics;
					costUsd = combined.costUsd;
				}
				verification = { ...verified.report, costUsd };
				debug.log('Verification finished', {
					status: verified.report.status,
					reason: verified.report.reason,
					checked: verified.report.checked,
					kept: verified.report.kept,
					dropped: verified.report.dropped,
					unjudged: verified.report.unjudged,
					costUsd,
				});
			}

			returnData.push({
				json: buildAgentOutput({
					messages,
					diagnostics,
					durationMs,
					includeTranscript: agent.includeTranscript,
					...(structured === undefined ? {} : { structured }),
					...(verifiedMetrics ? { metrics: verifiedMetrics } : {}),
					...(verification ? { verification } : {}),
				}),
				pairedItem: { item: itemIndex },
			});
		} catch (error) {
			const failure: FailureContext = {
				messages,
				diagnostics,
				nodeVersion: FAILURE_SHAPE_VERSION,
				itemIndex,
				timeoutSeconds,
				durationMs,
			};
			const settled = settleCaught(failure, error, () => ctx.continueOnFail(), false);
			returnData.push({ json: settle(settled, fail), pairedItem: { item: itemIndex } });
		} finally {
			staged?.cleanup();
			if (reporting) await reportAttempts(reporting, attempts, diagnostics, verifiedMetrics);
		}
	}

	return [returnData];
}

/**
 * One report per CLI run: a resume that found nothing was still a run, and may have cost. A
 * verification run is not reported on its own: its cost already includes the run it resumed, so
 * the final report carries the combined metrics instead.
 */
async function reportAttempts(
	reporting: { usage: UsageReporting; authMode: AuthMode; debug: DebugLogger },
	attempts: Attempt[],
	finalDiagnostics: Record<string, unknown> | null,
	finalMetrics: IDataObject | null,
): Promise<void> {
	for (const [index, attempt] of attempts.entries()) {
		const isFinal = index === attempts.length - 1;
		await reportRun({
			usage: reporting.usage,
			messages: attempt.sdkMessages,
			durationMs: attempt.run.durationMs,
			params: attempt.params,
			appliedEffort: attempt.run.appliedEffort,
			authMode: reporting.authMode,
			debug: reporting.debug,
			diagnostics: isFinal && finalDiagnostics ? (finalDiagnostics as IDataObject) : undefined,
			metrics: isFinal && finalMetrics ? finalMetrics : undefined,
		});
	}
}

function logSubagentInvocations(
	supplied: SuppliedSubagent[],
	attempts: Attempt[],
	debug: DebugLogger,
): void {
	const byName = new Map(supplied.map((s) => [s.name, s]));
	for (const attempt of attempts) {
		for (const invocation of subagentInvocations(attempt.sdkMessages)) {
			const log = byName.get(invocation.name)?.log;
			if (!log) continue;
			try {
				log(invocation);
			} catch (error) {
				debug.error('Subagent log failed (the run itself is unaffected)', {
					subagent: invocation.name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
}
