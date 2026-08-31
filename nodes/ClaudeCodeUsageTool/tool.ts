import { DynamicStructuredTool, type ToolSchemaBase } from '@langchain/core/tools';
import { buildAuthEnv, type AuthSelection } from '../shared/auth';
import type { ToolRunLog } from '../shared/toolRunLog';
import type { DebugLogger } from '../shared/debug';
import { readUsage as realReadUsage, UsageReadTimeoutError } from '../ClaudeCodeUsage/readUsage';
import { applyReadDiagnostics, escalateUsageRead } from '../ClaudeCodeUsage/escalate';
import { normalizeUsage, type UsageReport } from '../ClaudeCodeUsage/usage';

/**
 * Plan usage as a REAL zero-argument agent tool. The auto-generated `claudeCodeUsageTool`
 * wrapper drags the whole Usage node schema along; this one has a fixed contract — no arguments
 * in, one JSON report out as text — over the SAME read escalation the Usage node runs
 * (`ClaudeCodeUsage/escalate.ts`), so the two cannot report different numbers.
 *
 * Failures come back as text, never as a throw: "the usage endpoint refused this token" is an
 * answer the calling model can relay, not a reason to kill the run. And a report with no windows
 * carries the REASON — an agent handed `rateLimitsAvailable: false` and nothing else cannot act.
 *
 * The schema is JSON Schema for the same measured reason as the task tool — see the comment
 * there. An empty-properties object is exactly what a zero-argument tool should offer.
 */

export type UsageToolOptions = {
	timeoutMs: number;
	cwd?: string;
	pathToClaudeCodeExecutable?: string;
	declareProfileScope: boolean;
	probeIfUnavailable: boolean;
	includeAccountEmail: boolean;
};

export type ClaudeCodeUsageToolDeps = {
	name: string;
	description: string;
	auth: AuthSelection;
	options: UsageToolOptions;
	debug: DebugLogger;
	log?: ToolRunLog;
	/** Injected so tests never spawn a CLI. */
	readUsage?: typeof realReadUsage;
	/** Injected so tests never read the real process environment. */
	processEnv?: NodeJS.ProcessEnv;
};

/** A zero-argument tool, as JSON Schema. */
export const USAGE_TOOL_SCHEMA = { type: 'object', properties: {} } as const;

/**
 * Why a read came back without windows, in the words the Usage node uses when it refuses.
 * The tool cannot throw, so this is appended to the report instead — same four causes, same
 * fixes, because a model relaying "no limits available" with no reason helps nobody.
 */
export function explainMissingWindows(report: UsageReport): string {
	if (!report.authenticated) {
		return 'The Claude CLI has no login (tokenSource "none"), so there is no account to read limits for. Run `claude login` as the user n8n runs as, or make its ~/.claude visible to the n8n process — in Docker that means mounting it.';
	}
	if (report.planLimitsApply) {
		return 'This account has plan limits, but the read came back without them — the usage endpoint answered empty. Retry rather than treating it as unlimited.';
	}
	if (report.account.tokenSource === 'CLAUDE_CODE_OAUTH_TOKEN') {
		return 'This session authenticates with CLAUDE_CODE_OAUTH_TOKEN. Tokens from `claude setup-token` are inference-only by design, so the usage endpoint refuses them. Turn on "Probe With a Minimal Prompt If Unavailable" on this tool to read the 5-hour and 7-day windows off the rate-limit response headers instead — that costs about $0.001 per read.';
	}
	return 'This session has no plan limits: API key, Bedrock and Vertex logins are billed per token instead.';
}

export function buildClaudeCodeUsageTool(deps: ClaudeCodeUsageToolDeps): DynamicStructuredTool {
	const readUsage = deps.readUsage ?? realReadUsage;

	return new DynamicStructuredTool({
		name: deps.name,
		description: deps.description,
		// Zero arguments, structurally — the exact shape the bridge's exec-88 fix exists for.
		schema: USAGE_TOOL_SCHEMA as unknown as ToolSchemaBase,
		func: async (): Promise<string> => {
			const logIndex = deps.log?.start({});
			const done = (text: string): string => {
				if (logIndex !== undefined) deps.log?.end(logIndex, { response: text });
				return text;
			};
			try {
				const authEnv = buildAuthEnv(deps.auth, deps.processEnv ?? process.env);
				const read = await escalateUsageRead(
					readUsage,
					{
						timeoutMs: deps.options.timeoutMs,
						...(deps.options.cwd ? { cwd: deps.options.cwd } : {}),
						...(deps.options.pathToClaudeCodeExecutable
							? { pathToClaudeCodeExecutable: deps.options.pathToClaudeCodeExecutable }
							: {}),
						...(authEnv ? { authEnv } : {}),
					},
					{
						declareProfileScope: deps.options.declareProfileScope,
						probeIfUnavailable: deps.options.probeIfUnavailable,
					},
				);

				const report = normalizeUsage({
					...read.raw,
					fetchedAtMs: read.fetchedAtMs,
					includeEmail: deps.options.includeAccountEmail,
				});
				applyReadDiagnostics(report, read);

				deps.debug.lazy('Usage tool read', () => ({
					authenticated: report.authenticated,
					windows: report.windows.length,
					rateLimitsAvailable: report.rateLimitsAvailable,
					scopeRetried: read.scopeRetried,
					probeCostUsd: read.raw.probeCostUsd,
				}));

				const payload = report.rateLimitsAvailable
					? report
					: { ...report, whyNoWindows: explainMissingWindows(report) };
				return done(JSON.stringify(payload));
			} catch (error) {
				// Which control request was in flight is the useful half of a timeout, and the
				// Usage node's three explanations are exactly what the calling model needs to
				// decide whether to retry or give up.
				if (error instanceof UsageReadTimeoutError) {
					const fix =
						error.stage === 'initialize'
							? 'The CLI started but never answered — a slow SessionStart hook in the working directory is the usual cause. Raise the tool’s Timeout or point Project Path elsewhere.'
							: error.stage === 'probe'
								? 'The probe turn never finished, so there were no rate-limit headers to read. Raise the Timeout, or turn the probe off and accept the account data alone.'
								: 'The session answered but the usage request did not. Raise the Timeout and retry.';
					return done(`Could not read Claude plan usage: ${error.message}. ${fix}`);
				}
				const message = error instanceof Error ? error.message : String(error);
				return done(
					`Could not read Claude plan usage: ${message}. The read needs a logged-in Claude CLI — check that the n8n process can see ~/.claude, or that a credential is selected on this tool.`,
				);
			}
		},
	});
}
