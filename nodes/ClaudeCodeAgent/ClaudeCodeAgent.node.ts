import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createDebugLogger } from '../shared/debug';
import { lastResult } from '../shared/sdkMessage';
import { buildToolBridge } from '../shared/toolBridge';
import { prepareAttachments } from '../ClaudeCode/attachments/prepare';
import type { StagedAttachments } from '../ClaudeCode/attachments/types';
import type { FailureContext } from '../ClaudeCode/errors';
import {
	itemFailer,
	settle,
	settleCaught,
	settleRun,
	settleStructuredFailure,
	type ItemFailer,
} from '../ClaudeCode/settle';
import { claudeCodeAgentDescription } from './description';
import { orchestrationInstruction } from './orchestration';
import { buildAgentDiagnostics, buildAgentOutput } from './output';
import { readAgentParams } from './params';
import { prepareAgentRun } from './prepare';
import {
	agentReporting,
	logSubagentInvocations,
	reportAttempts,
	type AgentReporting,
} from './report';
import { extractStructured } from './structured';
import { buildSubagentReport } from './subagentReport';
import { createTurnRunner, runMainTurn, type Attempt } from './turn';
import { runVerification } from './verification/run';

export type AgentExecuteDeps = {
	/** The SDK's `query`. Injected so a test drives the message stream without spawning a CLI. */
	query: typeof query;
};

/** errors.ts shapes failures by node version; from 1.1 they are the shape n8n's error output
 * expects, which is the only shape this node has ever had. */
const FAILURE_SHAPE_VERSION = 1.1;

/** Held outside the item's try, so every exit path can still report what ran and what it cost. */
type ItemState = {
	messages: SDKMessage[];
	timeoutSeconds: number;
	durationMs: number;
	diagnostics: Record<string, unknown> | null;
	staged: StagedAttachments | null;
	attempts: Attempt[];
	reporting: AgentReporting | null;
	// Set only when a verification run happened: the item's one report then carries both runs.
	verifiedMetrics: IDataObject | null;
};

const failureOf = (item: ItemState, itemIndex: number): FailureContext => ({
	messages: item.messages,
	diagnostics: item.diagnostics,
	nodeVersion: FAILURE_SHAPE_VERSION,
	itemIndex,
	timeoutSeconds: item.timeoutSeconds,
	durationMs: item.durationMs,
});

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
		const item: ItemState = {
			messages: [],
			timeoutSeconds: 300,
			durationMs: 0,
			diagnostics: null,
			staged: null,
			attempts: [],
			reporting: null,
			verifiedMetrics: null,
		};
		const fail = itemFailer(ctx, itemIndex);

		try {
			const json = await runAgentItem(ctx, deps, itemIndex, item, fail);
			returnData.push({ json, pairedItem: { item: itemIndex } });
		} catch (error) {
			const failure = failureOf(item, itemIndex);
			const settled = settleCaught(failure, error, () => ctx.continueOnFail(), false);
			returnData.push({ json: settle(settled, fail), pairedItem: { item: itemIndex } });
		} finally {
			item.staged?.cleanup();
			if (item.reporting) {
				await reportAttempts(item.reporting, item.attempts, item.diagnostics, item.verifiedMetrics);
			}
		}
	}

	return [returnData];
}

/** One item, start to finish: its output json, a soft failure item, or a thrown error. */
async function runAgentItem(
	ctx: IExecuteFunctions,
	deps: AgentExecuteDeps,
	itemIndex: number,
	item: ItemState,
	fail: ItemFailer,
): Promise<IDataObject> {
	const { run: params, agent } = readAgentParams(ctx, itemIndex);
	item.timeoutSeconds = params.timeoutSeconds;
	const debug = createDebugLogger(ctx.logger, params.additional.debug === true);

	const prepared = await prepareAgentRun(ctx, itemIndex, params, agent);
	if ('problem' in prepared) throw fail(prepared.problem.message, prepared.problem.description);
	const { sessionUuid, subagents, subagentNames, schema, instructions } = prepared;

	const abortController = new AbortController();
	ctx.onExecutionCancellation(() => abortController.abort());

	const orchestration =
		agent.orchestration === 'required' ? orchestrationInstruction(subagentNames) : null;
	const attachments = await prepareAttachments(
		ctx,
		itemIndex,
		params.attachments,
		params.prompt,
		orchestration ? [orchestration] : [],
	);
	if ('problem' in attachments) {
		throw fail(attachments.problem.message, attachments.problem.description);
	}
	item.staged = attachments.staged;
	const { plan } = attachments;

	const bridge = buildToolBridge(prepared.connections.tools, (toolName, error) =>
		debug.error(`Bridged tool failed: ${toolName}`, {
			error: error instanceof Error ? error.message : String(error),
		}),
	);
	item.reporting = agentReporting(ctx, agent, debug, itemIndex, prepared.auth.mode);

	const runTurn = createTurnRunner({
		itemIndex,
		params,
		agent,
		prepared,
		bridge,
		stagedDir: item.staged?.dir,
		notes: plan.notes,
		abortController,
		query: deps.query,
		debug,
		fail,
	});
	const session = await runMainTurn(
		runTurn,
		{
			content: attachments.promptContent,
			outputFormat: schema ? { type: 'json_schema', schema: schema.schema } : undefined,
			sessionUuid,
			timeoutSeconds: item.timeoutSeconds,
			debug,
		},
		item,
	);
	const { run } = session.attempt;
	const messages = (item.messages = session.attempt.sdkMessages);
	item.durationMs = run.durationMs;

	logSubagentInvocations(subagents.supplied, item.attempts, debug);

	const structuredOutcome = schema ? extractStructured(messages) : null;
	const diagnostics = buildAgentDiagnostics({
		messages,
		params: session.attempt.params,
		permissionMode: session.attempt.permissionMode,
		appliedEffort: run.appliedEffort,
		attachments: plan.report,
		authMode: prepared.auth.mode,
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
	item.diagnostics = diagnostics;
	const failure = failureOf(item, itemIndex);

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
	if (settled) return settle(settled, fail);

	if (structuredOutcome && 'failure' in structuredOutcome) {
		return settle(
			settleStructuredFailure(failure, structuredOutcome.failure, () => ctx.continueOnFail()),
			fail,
		);
	}

	let structured =
		structuredOutcome && 'ok' in structuredOutcome ? structuredOutcome.ok : undefined;
	let verification: IDataObject | undefined;
	if (agent.verification && structured !== undefined) {
		const verified = await runVerification({
			verification: agent.verification,
			structured,
			messages,
			durationMs: item.durationMs,
			timeoutSeconds: params.timeoutSeconds,
			runTurn,
			onAttempt: (attempt) => logSubagentInvocations(subagents.supplied, [attempt], debug),
			debug,
		});
		structured = verified.structured;
		item.verifiedMetrics = verified.metrics;
		verification = verified.report;
	}

	return buildAgentOutput({
		messages,
		diagnostics,
		durationMs: item.durationMs,
		includeTranscript: agent.includeTranscript,
		...(structured === undefined ? {} : { structured }),
		...(item.verifiedMetrics ? { metrics: item.verifiedMetrics } : {}),
		...(verification ? { verification } : {}),
	});
}
