import type { OutputFormat, SDKMessage, query } from '@anthropic-ai/claude-agent-sdk';
import type { DebugLogger } from '../shared/debug';
import {
	runWithSession,
	type SessionAttempt,
	type SessionRequest,
	type SessionRun,
} from '../shared/session';
import type { ToolBridge } from '../shared/toolBridge';
import { buildQueryOptions } from '../ClaudeCode/config';
import type { ItemFailer } from '../ClaudeCode/settle';
import { createPromptStream, type PromptContent } from '../ClaudeCode/promptStream';
import { runQuery } from '../ClaudeCode/runner';
import type { ClaudeCodeParams, RunOutcome } from '../ClaudeCode/types';
import type { AgentExtras } from './params';
import type { PreparedAgent } from './prepare';

/** One CLI run: the main run, the create after a resume found nothing, or a verification run. */
export type Attempt = SessionAttempt & {
	run: RunOutcome;
	params: ClaudeCodeParams;
	graceSeconds: number;
	permissionMode: string;
};

export type Turn = {
	content: PromptContent;
	outputFormat: OutputFormat | undefined;
	label: string;
	forkSession?: boolean;
};

export type TurnRunner = (
	session: SessionRequest,
	budget: { timeoutSeconds: number },
	turn: Turn,
	sdkMessages: SDKMessage[],
) => Promise<Attempt>;

export type TurnSetup = {
	itemIndex: number;
	params: ClaudeCodeParams;
	agent: AgentExtras;
	prepared: PreparedAgent;
	bridge: ToolBridge | null;
	stagedDir: string | undefined;
	/** The attachment plan's routing notes, for the debug log. */
	notes: Record<string, unknown>;
	abortController: AbortController;
	query: typeof query;
	debug: DebugLogger;
	fail: ItemFailer;
};

/** Runs one turn of the item's session. Every run of an item shares its abort controller. */
export function createTurnRunner(setup: TurnSetup): TurnRunner {
	const { itemIndex, params, agent, prepared, bridge, abortController, debug } = setup;
	let appliedEffort: string | undefined;

	return async (session, budget, turn, sdkMessages) => {
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
			stagedDir: setup.stagedDir,
			auth: prepared.auth,
			onEffort: (level) => {
				appliedEffort = level;
			},
			mcp: bridge ?? undefined,
			agents: prepared.subagents.agents,
			outputFormat: turn.outputFormat,
			instructionsAppend: prepared.instructions?.append,
			claudeAiConnectors: agent.allowConnectors ? undefined : false,
			newSessionId: session && 'create' in session ? session.create : undefined,
			forkSession: turn.forkSession,
		});
		if ('problem' in outcome) {
			throw setup.fail(outcome.problem.message, outcome.problem.description);
		}
		const { queryOptions, graceWindow } = outcome.config;

		debug.log(turn.label, {
			itemIndex,
			prompt: params.prompt.substring(0, 100) + '...',
			model: params.model,
			maxTurns: params.maxTurns,
			timeout: `${budget.timeoutSeconds}s`,
			session: session ?? 'new',
			subagents: prepared.subagentNames,
			bridgedTools: bridge?.toolNames ?? [],
			outputMode: agent.outputMode,
			appliedOptions: outcome.config.applied,
			...setup.notes,
			...outcome.config.notes,
		});

		const run = await runQuery({
			queryOptions,
			graceWindow,
			promptStream,
			abortController,
			query: setup.query,
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
}

/**
 * The main run, resumed or created under the Session Key when there is one. `state.messages`
 * always holds the current attempt's messages, and every attempt lands in `state.attempts`, so a
 * failure mid-way still reports what ran.
 */
export async function runMainTurn(
	runTurn: TurnRunner,
	input: {
		content: PromptContent;
		outputFormat: OutputFormat | undefined;
		sessionUuid: string | null;
		timeoutSeconds: number;
		debug: DebugLogger;
	},
	state: { messages: SDKMessage[]; attempts: Attempt[] },
): Promise<SessionRun<Attempt>> {
	const runOnce = async (
		session: SessionRequest,
		budget: { timeoutSeconds: number },
	): Promise<Attempt> => {
		const sdkMessages: SDKMessage[] = [];
		state.messages = sdkMessages;
		const attempt = await runTurn(
			session,
			budget,
			{
				content: input.content,
				outputFormat: input.outputFormat,
				label: 'Starting Claude Code Agent execution',
			},
			sdkMessages,
		);
		state.attempts.push(attempt);
		return attempt;
	};

	const { sessionUuid, timeoutSeconds, debug } = input;
	return sessionUuid
		? runWithSession(runOnce, { sessionUuid, timeoutSeconds, debug })
		: { attempt: await runOnce(null, { timeoutSeconds }), state: 'new', unrecoverable: false };
}
