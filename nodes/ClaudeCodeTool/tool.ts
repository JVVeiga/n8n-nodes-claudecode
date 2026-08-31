import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { DynamicStructuredTool, type ToolSchemaBase } from '@langchain/core/tools';
import { attachAbort } from '../shared/abort';
import type { ToolRunLog } from '../shared/toolRunLog';
import { preview } from '../shared/preview';
import type { AuthSelection } from '../shared/auth';
import type { DebugLogger } from '../shared/debug';
import { buildQueryOptions } from '../ClaudeCode/config';
import { resolveResultText } from '../ClaudeCode/output/resultText';
import { createPromptStream } from '../ClaudeCode/promptStream';
import { runQuery } from '../ClaudeCode/runner';
import { collectRunMetrics } from '../ClaudeCode/timeout';
import { reportRun, type UsageReporting } from '../shared/usageReport';
import type { ClaudeCodeParams } from '../ClaudeCode/types';

/**
 * Claude Code as a REAL agent tool: one argument (`task`), text out, never throws.
 *
 * This is what the auto-generated `claudeCodeTool` wrapper is not (CONCERNS d2): the schema is
 * fixed and self-describing — the Agent always knows how to call it, no `$fromAI` hand-wiring —
 * and every failure comes back as text the calling model can read and react to, because a tool
 * that throws turns one bad call into a dead run.
 *
 * The tool instance belongs to OUR `@langchain/core`; every consumer seam is duck-typed
 * (spec F-06), and the Chat Model's MCP bridge reads it structurally (`planTool`), so it works
 * the same under a native Agent model or under our own.
 *
 * **The schema is JSON Schema, deliberately — never a zod object.** n8n's `normalizeToolSchema`
 * decides with `tool.schema instanceof ZodType` against ITS OWN zod copy, and an instance from
 * ours never satisfies that (measured for both `zod/v4` and `zod/v3`: false). It then feeds our
 * zod object to `convertJsonSchemaToZod`, which returns a mangled `ZodDefault` — the tool the
 * model is offered stops matching the tool that exists, and the call fails before the handler
 * runs. Handing over plain JSON Schema puts n8n on its own happy path: it builds a real
 * `ZodObject` with its own zod, which every consumer downstream accepts.
 */

export type ClaudeCodeTaskToolDeps = {
	/** The tool's wire name, derived from the node's name the way n8n derives it. */
	name: string;
	description: string;
	params: ClaudeCodeParams;
	auth: AuthSelection;
	query: typeof sdkQuery;
	debug: DebugLogger;
	log?: ToolRunLog;
	cancelSignal?: AbortSignal;
	/** Injected so tests never read the real process environment. */
	processEnv?: NodeJS.ProcessEnv;
	/** Reporting, whole or not at all — see UsageReporting. */
	usage?: UsageReporting;
};

/** What the Agent is offered. JSON Schema, for the reason in the module comment. */
export const TASK_TOOL_SCHEMA = {
	type: 'object',
	properties: {
		task: {
			type: 'string',
			description: 'The task to execute, in clear natural language',
		},
	},
	required: ['task'],
} as const;

export function buildClaudeCodeTaskTool(deps: ClaudeCodeTaskToolDeps): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: deps.name,
		description: deps.description,
		schema: TASK_TOOL_SCHEMA as unknown as ToolSchemaBase,
		func: async ({ task }: { task: string }): Promise<string> => {
			const logIndex = deps.log?.start({ task });
			const done = (text: string): string => {
				if (logIndex !== undefined) deps.log?.end(logIndex, { response: text });
				return text;
			};

			const abortController = new AbortController();
			const abort = () => abortController.abort();
			// Removed in the finally below: `deps.cancelSignal` is fetched once per supplyData and
			// lives for the whole execution, so a listener per invocation accumulates across an
			// agent loop until Node warns about a leak.
			const listening = attachAbort([deps.cancelSignal], abort);

			try {
				const promptStream = createPromptStream(task);
				// Captured, not discarded: the effort Claude Code actually applied is part of the
				// diagnostics the main node reports, and a tool's row was the only one always
				// saying null.
				let appliedEffort: string | undefined;
				const outcome = buildQueryOptions(deps.params, {
					abortController,
					promptStream,
					auth: deps.auth,
					processEnv: deps.processEnv,
					onEffort: (level) => {
						appliedEffort = level;
					},
				});
				if ('problem' in outcome) {
					const { problem } = outcome;
					// Text, not a throw: the calling model can read this and correct course.
					return done(
						`Configuration error: ${problem.message}${problem.description ? ` — ${problem.description}` : ''}`,
					);
				}

				const messages: SDKMessage[] = [];
				const run = await runQuery({
					queryOptions: outcome.config.queryOptions,
					graceWindow: outcome.config.graceWindow,
					promptStream,
					abortController,
					query: deps.query,
					debug: deps.debug,
					messages,
					getAppliedEffort: () => appliedEffort,
				});

				// Reported before the text is shaped, so a timeout reports too — a run that spent
				// money and ran out of time is exactly the one worth having in the table.
				await reportRun({
					usage: deps.usage,
					messages,
					durationMs: run.durationMs,
					params: deps.params,
					appliedEffort: run.appliedEffort,
					authMode: deps.auth.mode,
					debug: deps.debug,
				});

				const text = resolveResultText(messages).text;
				deps.debug.lazy('Claude Code task tool run finished', () => ({
					task: preview(task, 800),
					timedOut: run.timedOut,
					durationMs: run.durationMs,
					metrics: collectRunMetrics(messages),
				}));

				if (run.timedOut) {
					return done(
						`Claude Code timed out after ${deps.params.timeoutSeconds}s.` +
							(text ? ` Partial result: ${text}` : ' No partial result was recovered.'),
					);
				}
				if (run.error !== null) {
					const message = run.error instanceof Error ? run.error.message : String(run.error);
					return done(`Claude Code failed: ${message}`);
				}
				return done(text);
			} catch (error) {
				// The contract is "never throws", and without this it was a lie: `query()` throws
				// SYNCHRONOUSLY from runner.ts for a missing CLI binary or a bad plugin config, which
				// killed the Agent run and left this tool's log entry open forever.
				const message = error instanceof Error ? error.message : String(error);
				if (logIndex !== undefined) deps.log?.error(logIndex, error);
				return `Claude Code failed: ${message}`;
			} finally {
				listening.detach();
			}
		},
	});
}
