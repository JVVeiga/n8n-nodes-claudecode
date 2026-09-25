import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AuthMode } from '../shared/auth';
import { createDebugLogger, type DebugLogger } from '../shared/debug';
import { lastResult } from '../shared/sdkMessage';
import { readAuth } from '../shared/readAuth';
import { usageReporting } from '../shared/reportUsage';
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
import { collectAttachments } from '../ClaudeCode/attachments/collect';
import { planAttachments, stagedHintBlock } from '../ClaudeCode/attachments/plan';
import { stageAttachments } from '../ClaudeCode/attachments/stage';
import type { StagedAttachments } from '../ClaudeCode/attachments/types';
import { buildQueryOptions } from '../ClaudeCode/config';
import {
	buildFailureItem,
	buildStructuredFailureItem,
	buildTimeoutFailureItem,
	buildTimeoutReport,
	userFacingMessage,
	type FailureContext,
} from '../ClaudeCode/errors';
import { checkPrompt } from '../ClaudeCode/params';
import { createPromptStream, type PromptContent } from '../ClaudeCode/promptStream';
import { runQuery } from '../ClaudeCode/runner';
import type { ClaudeCodeParams, RunOutcome } from '../ClaudeCode/types';
import { readConnections } from './connections';
import { claudeCodeAgentDescription } from './description';
import { readInstructions } from './instructions';
import { orchestrationInstruction } from './orchestration';
import { buildAgentDiagnostics, buildAgentOutput } from './output';
import { resolveOutputSchema } from './outputSchema';
import { readAgentParams } from './params';
import { extractStructured } from './structured';
import { buildSubagentReport, subagentInvocations } from './subagentReport';
import { buildSubagents } from './subagents';

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

		const fail = (message: string, description?: string, type?: string) =>
			new NodeOperationError(ctx.getNode(), message, {
				itemIndex,
				...(description ? { description } : {}),
				...(type ? { type } : {}),
			});

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

			const instructions =
				agent.instructionFiles.length > 0
					? readInstructions(params.projectPath, agent.instructionFiles)
					: null;
			if (instructions && 'problem' in instructions) {
				throw fail(instructions.problem.message, instructions.problem.description);
			}

			const abortController = new AbortController();
			ctx.onExecutionCancellation(() => abortController.abort());

			const collected = await collectAttachments(ctx, itemIndex, params.attachments);
			if ('problem' in collected) {
				throw fail(collected.problem.message, collected.problem.description);
			}
			const plan = planAttachments(collected.attachments, params.attachments, collected.skipped);
			if (plan.toStage.length > 0) {
				staged = stageAttachments(plan.toStage);
				if (plan.report?.staged) plan.report.staged.dir = staged.dir;
			}

			const orchestration =
				agent.orchestration === 'required' ? orchestrationInstruction(subagentNames) : null;
			const promptContent: PromptContent =
				plan.blocks.length === 0 && staged === null && orchestration === null
					? params.prompt
					: [
							...plan.blocks,
							...(staged ? [stagedHintBlock(staged.dir, plan.report?.staged?.files ?? [])] : []),
							{ type: 'text' as const, text: params.prompt },
							...(orchestration ? [{ type: 'text' as const, text: orchestration }] : []),
						];

			const bridge = buildToolBridge(connections.tools, (toolName, error) =>
				debug.error(`Bridged tool failed: ${toolName}`, {
					error: error instanceof Error ? error.message : String(error),
				}),
			);

			const usage = usageReporting(ctx, agent, debug, createSequence(), itemIndex);
			if (usage) reporting = { usage, authMode: auth.mode, debug };

			let appliedEffort: string | undefined;

			const runOnce = async (
				session: SessionRequest,
				budget: { timeoutSeconds: number },
			): Promise<Attempt> => {
				// Each attempt needs its own stream: the previous one was closed by its run.
				const promptStream = createPromptStream(promptContent);
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
					outputFormat: schema ? { type: 'json_schema', schema: schema.schema } : undefined,
					instructionsAppend: instructions?.append,
					claudeAiConnectors: agent.allowConnectors ? undefined : false,
					newSessionId: session && 'create' in session ? session.create : undefined,
				});
				if ('problem' in outcome) {
					throw fail(outcome.problem.message, outcome.problem.description);
				}
				const { queryOptions, graceWindow } = outcome.config;

				debug.log('Starting Claude Code Agent execution', {
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

				const sdkMessages: SDKMessage[] = [];
				messages = sdkMessages;
				const run = await runQuery({
					queryOptions,
					graceWindow,
					promptStream,
					abortController,
					query: deps.query,
					debug,
					messages: sdkMessages,
					getAppliedEffort: () => appliedEffort,
				});
				const attempt: Attempt = {
					run,
					sdkMessages,
					params: runParams,
					graceSeconds: graceWindow.graceSeconds,
					permissionMode: queryOptions.options.permissionMode as string,
				};
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

			if (run.timedOut) {
				const report = buildTimeoutReport(failure, run, session.attempt.graceSeconds);
				if (ctx.continueOnFail()) {
					returnData.push({
						json: buildTimeoutFailureItem(failure, report),
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				const error = fail(report.message, report.description, 'timeout');
				error.context = report.context;
				throw error;
			}

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
			if (runError !== null) {
				const errorMessage = runError instanceof Error ? runError.message : String(runError);
				if (ctx.continueOnFail()) {
					returnData.push({
						json: buildFailureItem(failure, errorMessage, {
							isTimeout: false,
							stack: runError instanceof Error ? runError.stack : undefined,
						}),
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw fail(userFacingMessage(errorMessage, false, timeoutSeconds), errorMessage);
			}

			if (structuredOutcome && 'failure' in structuredOutcome) {
				const message = `Claude Code did not return the structured output: ${structuredOutcome.failure}`;
				if (ctx.continueOnFail()) {
					returnData.push({
						json: buildStructuredFailureItem(failure, message),
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw fail(
					message,
					'The run finished without an object matching the schema. diagnostics.structuredOutput.attempts counts its tries; a clearer schema or prompt usually helps.',
					'structured_output',
				);
			}

			returnData.push({
				json: buildAgentOutput({
					messages,
					diagnostics,
					durationMs,
					includeTranscript: agent.includeTranscript,
					...(structuredOutcome && 'ok' in structuredOutcome
						? { structured: structuredOutcome.ok }
						: {}),
				}),
				pairedItem: { item: itemIndex },
			});
		} catch (error) {
			if (error instanceof NodeOperationError && !ctx.continueOnFail()) throw error;

			const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
			if (ctx.continueOnFail()) {
				returnData.push({
					json: buildFailureItem(
						{
							messages,
							diagnostics,
							nodeVersion: FAILURE_SHAPE_VERSION,
							itemIndex,
							timeoutSeconds,
							durationMs,
						},
						errorMessage,
						{ isTimeout: false, stack: error instanceof Error ? error.stack : undefined },
					),
					pairedItem: { item: itemIndex },
				});
				continue;
			}
			throw fail(userFacingMessage(errorMessage, false, timeoutSeconds), errorMessage);
		} finally {
			staged?.cleanup();
			if (reporting) await reportAttempts(reporting, attempts, diagnostics);
		}
	}

	return [returnData];
}

/** One report per CLI run: a resume that found nothing was still a run, and may have cost. */
async function reportAttempts(
	reporting: { usage: UsageReporting; authMode: AuthMode; debug: DebugLogger },
	attempts: Attempt[],
	finalDiagnostics: Record<string, unknown> | null,
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
