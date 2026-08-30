import type { PromptStream } from './promptStream';
import { buildAuthEnv, type AuthSelection } from '../shared/auth';
import type { Problem } from '../shared/problem';
import { checkProjectPath, isDirectory } from '../shared/projectPath';
import { effectiveEffort, isUltracode } from './params';
import { resolveGraceWindow, type GraceWindow } from './timeout';
import type { ClaudeCodeParams, QueryOptions, SdkOptions } from './types';

/**
 * Turning node parameters into SDK options.
 *
 * This was ~15 sequential `if` blocks mutating one object inside execute(), each with its own
 * hard-won comment, none of them reachable from a test. It is now an ordered table of appliers:
 * adding a new SDK option is one entry, and each entry can be asserted on its own.
 *
 * Pure by construction. The filesystem check and the AbortController arrive through `deps`, so a
 * test never touches a disk and never spawns anything.
 */

export type ConfigDeps = {
	abortController: AbortController;
	promptStream: PromptStream;
	/** Called with the effort level Claude Code reports applying, from inside its hooks. */
	onEffort: (level: string) => void;
	/** Injected so config tests need no filesystem. */
	pathExists?: (path: string) => boolean;
	/** Which account this execution authenticates as. A runtime fact, like `stagedDir` — it comes
	 * from an async `getCredentials()` call that `readParams` cannot make. Absent means host. */
	auth?: AuthSelection;
	/** Injected so config tests never read the real process environment. */
	processEnv?: NodeJS.ProcessEnv;
	/** The temp directory holding staged attachments, when there were any. A runtime fact rather
	 * than a parameter, which is why it arrives here alongside the AbortController. */
	stagedDir?: string;
};

export type ConfigResult = {
	queryOptions: QueryOptions;
	graceWindow: GraceWindow;
	ultracode: boolean;
	/** Facts worth logging, collected as the appliers run, so debug logging is not woven in. */
	notes: Record<string, unknown>;
	/** Which appliers actually changed something. Useful in a debug log and in tests. */
	applied: string[];
};

export type ConfigOutcome = { config: ConfigResult } | { problem: Problem };

type ApplyContext = {
	options: SdkOptions;
	params: ClaudeCodeParams;
	ultracode: boolean;
	deps: ConfigDeps;
	note: (key: string, value: unknown) => void;
};

/** Returns a Problem to abort, `true` when it changed something, `false`/void when it did nothing. */
type Applier = { name: string; apply: (ctx: ApplyContext) => Problem | boolean | void };

/** Ultracode needs these to orchestrate at all. */
const withOrchestration = (tools: string[]): string[] =>
	Array.from(new Set([...tools, 'Workflow', 'Task']));

const APPLIERS: Applier[] = [
	{
		// Plan mode exposes no exit tool unless a permission callback is registered, so on its own
		// it always ends with a plan and nothing written. Registering one lets Claude leave plan
		// mode and act.
		name: 'planExecution',
		apply: ({ options, params }) => {
			if (options.permissionMode !== 'plan' || !params.additional.allowPlanExecution) return false;
			options.canUseTool = async (_toolName, input) => ({
				behavior: 'allow',
				updatedInput: input,
			});
			return true;
		},
	},
	{
		// Ultracode as a real session setting: standing dynamic-workflow orchestration at xhigh
		// effort. Requires an xhigh-capable model and workflows enabled.
		name: 'ultracodeSetting',
		apply: ({ options, ultracode }) => {
			if (!ultracode) return false;
			options.settings = { ultracode: true };
			return true;
		},
	},
	{
		// The effort Claude Code actually applies, post-downgrade, is exposed only inside hooks and
		// never in the message stream. Stop/SubagentStop fire at end of turn, so a plain reply with
		// no tool use is covered too.
		name: 'effortCapture',
		apply: ({ options, deps }) => {
			const captureEffort = async (input: unknown) => {
				const level = (input as { effort?: { level?: string } })?.effort?.level;
				if (level) deps.onEffort(level);
				return { continue: true };
			};
			const hook = [{ hooks: [captureEffort] }];
			options.hooks = {
				PreToolUse: hook,
				PostToolUse: hook,
				Stop: hook,
				SubagentStop: hook,
			} as SdkOptions['hooks'];
			return true;
		},
	},
	{
		// Appended to Claude Code's own preset rather than replacing it, so the built-in agent
		// behaviour survives a custom system prompt.
		name: 'systemPrompt',
		apply: ({ options, params }) => {
			if (!params.additional.systemPrompt) return false;
			options.systemPrompt = {
				type: 'preset',
				preset: 'claude_code',
				append: params.additional.systemPrompt,
			};
			return true;
		},
	},
	{
		// A globally installed CLI instead of the one bundled with the SDK.
		name: 'executablePath',
		apply: ({ options, params }) => {
			const path = params.additional.pathToClaudeCodeExecutable?.trim();
			if (!path) return false;
			options.pathToClaudeCodeExecutable = path;
			return true;
		},
	},
	{
		// `Options.env` REPLACES the subprocess environment rather than merging into it, so host
		// mode has to leave the option absent: a spread copy of process.env would behave the same
		// today while making the default path structurally different from the one every existing
		// workflow runs on. buildAuthEnv returns undefined for host, which is what expresses that.
		name: 'authEnv',
		apply: ({ options, deps, note }) => {
			const auth = deps.auth ?? { mode: 'host' as const };
			const env = buildAuthEnv(auth, deps.processEnv ?? process.env);
			if (!env) return false;
			options.env = env;
			// The mode, never the secret. This note reaches the debug log verbatim.
			note('authMode', auth.mode);
			return true;
		},
	},
	{
		name: 'projectPath',
		apply: ({ options, params, deps, note }) => {
			const problem = checkProjectPath(params.projectPath, deps.pathExists ?? isDirectory);
			if (problem) return problem;
			const cwd = params.projectPath.trim();
			if (cwd === '') return false;
			options.cwd = cwd;
			note('cwd', cwd);
			return true;
		},
	},
	{
		// Restrict Built-in Tools is the real allowlist: an empty selection keeps the full set.
		// Ultracode needs Workflow and Task, so add them rather than let a restriction silently
		// disable orchestration — but only when a restriction was actually asked for.
		name: 'restrictTools',
		apply: ({ options, params, ultracode, note }) => {
			const tools =
				ultracode && params.restrictTools.length > 0
					? withOrchestration(params.restrictTools)
					: params.restrictTools;
			if (tools.length === 0) return false;
			options.tools = tools;
			note('tools', tools);
			return true;
		},
	},
	{
		// Files too large or of a type no content block can carry are written to a temp directory,
		// which the CLI can only reach if it is named here.
		//
		// Placed after restrictTools so it amends a set that already exists on the options.
		name: 'stagedAttachments',
		apply: ({ options, params, deps, note }) => {
			const dir = deps.stagedDir;
			if (!dir) return false;
			options.additionalDirectories = [dir];

			// Restrict Built-in Tools is the real allowlist, and a restriction that omits Read makes
			// staging fail silently: the run answers without ever having seen the file. Add Read
			// rather than let that happen — the same reasoning as withOrchestration adding
			// Workflow/Task under Ultracode. An empty restriction already has the full set.
			if (params.restrictTools.length > 0 && !params.restrictTools.includes('Read')) {
				// Read what restrictTools actually put there rather than params.restrictTools, so an
				// Ultracode run keeps the Workflow/Task entries withOrchestration added. `tools` can
				// also be a `{type:'preset'}` object per the SDK; the applier above never sets that,
				// and the fallback covers it without asserting.
				const current = Array.isArray(options.tools) ? options.tools : params.restrictTools;
				options.tools = Array.from(new Set([...current, 'Read']));
				note('readAddedForStaging', true);
				// Overwrite the note restrictTools already wrote, so the debug log reports the list
				// actually sent rather than the one before the injection. Without this the log says
				// ["Bash","Grep"] on a run that really sent ["Bash","Grep","Read"] — misleading in
				// exactly the situation this applier exists to make debuggable.
				note('tools', options.tools);
			}

			note('stagedDir', dir);
			return true;
		},
	},
	{
		// Allowed Tools is the SDK's auto-approve list — it pre-approves tools rather than
		// restricting the set. Under Ultracode, pre-approve what the orchestration needs so it is
		// not gated by a permission prompt.
		name: 'allowedTools',
		apply: ({ options, params, ultracode, note }) => {
			const tools =
				ultracode && params.allowedTools.length > 0
					? withOrchestration(params.allowedTools)
					: params.allowedTools;
			if (tools.length === 0) return false;
			options.allowedTools = tools;
			note('allowedTools', tools);
			return true;
		},
	},
	{
		name: 'disallowedTools',
		apply: ({ options, params, note }) => {
			if (params.disallowedTools.length === 0) return false;
			options.disallowedTools = params.disallowedTools;
			note('disallowedTools', params.disallowedTools);
			return true;
		},
	},
	{
		// The two model dropdowns share their values, and the SDK throws before spawning when they
		// match. Caught here so the message names the n8n field instead of an SDK internal.
		name: 'fallbackModel',
		apply: ({ options, params }) => {
			const fallback = params.additional.fallbackModel;
			if (!fallback) return false;
			if (fallback === params.model) {
				return {
					message: 'Fallback Model must be different from Model',
					description:
						'The fallback is only used when the primary model is overloaded. Pick a different model, or set Fallback Model to None.',
				};
			}
			options.fallbackModel = fallback;
			return true;
		},
	},
	{
		// When set, this takes precedence over Max Thinking Tokens — the SDK's own rule, not ours.
		name: 'thinking',
		apply: ({ options, params }) => {
			switch (params.additional.thinking) {
				case 'disabled':
					options.thinking = { type: 'disabled' };
					return true;
				case 'adaptive':
					options.thinking = { type: 'adaptive' };
					return true;
				case 'summarized':
					options.thinking = { type: 'adaptive', display: 'summarized' };
					return true;
				default:
					return false;
			}
		},
	},
	{
		name: 'maxThinkingTokens',
		apply: ({ options, params }) => {
			const tokens = params.additional.maxThinkingTokens;
			if (!tokens || tokens <= 0) return false;
			options.maxThinkingTokens = tokens;
			return true;
		},
	},
	{
		// The only money bound the SDK offers. Max Turns and Timeout bound how long a run goes, not
		// what it costs.
		name: 'maxBudgetUsd',
		apply: ({ options, params }) => {
			const budget = params.additional.maxBudgetUsd;
			if (!budget || budget <= 0) return false;
			options.maxBudgetUsd = budget;
			return true;
		},
	},
	{
		// Resume an explicit session when one is given. Otherwise `continue`, which resolves "the
		// most recent conversation in this directory" — shared by every execution on the instance,
		// so concurrent runs collide. That is why Session ID exists.
		name: 'resumeOrContinue',
		apply: ({ options, params, note }) => {
			if (params.operation !== 'continue') return false;
			if (params.sessionId) {
				options.resume = params.sessionId;
				note('resume', params.sessionId);
			} else {
				options.continue = true;
				note('continue', true);
			}
			return true;
		},
	},
];

/** The applier names, in order. Exported so a test can pin the order rather than infer it. */
export const APPLIER_NAMES = APPLIERS.map((a) => a.name);

export function buildQueryOptions(params: ClaudeCodeParams, deps: ConfigDeps): ConfigOutcome {
	const ultracode = isUltracode(params);

	const options: SdkOptions = {
		abortController: deps.abortController,
		maxTurns: params.maxTurns,
		permissionMode: params.additional.permissionMode || 'bypassPermissions',
		model: params.model,
		effort: effectiveEffort(params),
	};

	const notes: Record<string, unknown> = {};
	const applied: string[] = [];
	const ctx: ApplyContext = {
		options,
		params,
		ultracode,
		deps,
		note: (key, value) => {
			notes[key] = value;
		},
	};

	for (const applier of APPLIERS) {
		const outcome = applier.apply(ctx);
		if (outcome && typeof outcome === 'object') return { problem: outcome };
		if (outcome === true) applied.push(applier.name);
	}

	return {
		config: {
			queryOptions: { prompt: deps.promptStream.stream, options },
			// The grace default is resolved in params.ts, so by here it is always a number.
			graceWindow: resolveGraceWindow(
				params.timeoutSeconds,
				params.additional.wrapUpGraceSeconds as number,
			),
			ultracode,
			notes,
			applied,
		},
	};
}
