import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	PROBE_PROMPT,
	PROFILE_SCOPES,
	readUsage,
	UsageReadTimeoutError,
	type UsageReadResult,
} from './readUsage';
import { normalizeUsage, shouldRetryWithProfileScope, type UsageReport } from './usage';
import { checkProjectPath } from '../shared/projectPath';
import { createDebugLogger } from '../shared/debug';
import { claudeCodeUsageDescription } from './description';

type UsageOptions = {
	includeRawLimits?: boolean;
	includeAccountEmail?: boolean;
	errorIfLimitsUnavailable?: boolean;
	declareProfileScope?: boolean;
	probeIfUnavailable?: boolean;
	debug?: boolean;
	pathToClaudeCodeExecutable?: string;
};

/**
 * Same split as the Claude Code node, for the same reason: n8n calls `execute` as
 * `execute.call(executionContext)`, so `this` is the context and instance fields are unreachable
 * from inside. The work lives in `readUsageItems`, which takes `readUsage` as an argument, and
 * `execute()` is a one-line adapter.
 *
 * `readUsage` itself stays untested (spec N-3) — it spawns a real CLI, and faking that means faking
 * the SDK's control-request surface. Injecting it is what makes everything AROUND it testable: the
 * per-path read cache, the scope-retry then probe escalation, and the four different explanations
 * for "no plan limits".
 */
export type UsageDeps = {
	readUsage: typeof readUsage;
};

export class ClaudeCodeUsage implements INodeType {
	description: INodeTypeDescription = claudeCodeUsageDescription;

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return readUsageItems(this, { readUsage });
	}
}

export async function readUsageItems(
	ctx: IExecuteFunctions,
	deps: UsageDeps,
): Promise<INodeExecutionData[][]> {
	const items = ctx.getInputData();
	const returnData: INodeExecutionData[] = [];

	// Plan capacity is account-wide, so N items must not open N sessions at ~2s each. One read per
	// distinct working directory is the finest granularity that can differ, because settings and
	// hooks resolve per directory.
	//
	// The timestamp is cached with the read rather than taken per item: items served by the same
	// read must report the same `fetchedAt`, and every countdown in them is derived from it.
	type CachedRead = { raw: UsageReadResult; fetchedAtMs: number; scopeRetried: boolean };
	const readsByPath = new Map<string, Promise<CachedRead>>();

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const projectPath = (ctx.getNodeParameter('projectPath', itemIndex) as string).trim();
		const timeout = ctx.getNodeParameter('timeout', itemIndex) as number;
		const options = ctx.getNodeParameter('usageOptions', itemIndex, {}) as UsageOptions;
		const executable = (options.pathToClaudeCodeExecutable ?? '').trim();

		// Validated before spawning — see checkProjectPath for why a bad path must not be left
		// for the SDK's spawn-error handler to misdiagnose.
		const pathProblem = checkProjectPath(projectPath);
		if (pathProblem) {
			throw new NodeOperationError(ctx.getNode(), pathProblem.message, {
				itemIndex,
				description: pathProblem.description,
			});
		}

		const declareProfileScope = options.declareProfileScope !== false;
		const probeIfUnavailable = options.probeIfUnavailable === true;

		// Serialised rather than concatenated: a separator character could appear inside a path.
		const cacheKey = JSON.stringify([
			projectPath,
			executable,
			timeout,
			declareProfileScope,
			probeIfUnavailable,
		]);
		let pending = readsByPath.get(cacheKey);
		const reusedRead = pending !== undefined;
		if (!pending) {
			const readOptions = {
				timeoutMs: Math.max(1, timeout) * 1000,
				...(projectPath ? { cwd: projectPath } : {}),
				...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
			};

			// The escalation lives inside the cached promise so a batch pays for it once, and every
			// item reports the same numbers and the same fetchedAt.
			pending = (async (): Promise<CachedRead> => {
				const raw = await deps.readUsage(readOptions);
				const done = (r: UsageReadResult, scopeRetried: boolean): CachedRead => ({
					raw: r,
					fetchedAtMs: Date.now(),
					scopeRetried,
				});

				if (!declareProfileScope) return done(raw, false);
				if (!shouldRetryWithProfileScope(normalizeUsage({ ...raw, fetchedAtMs: Date.now() }))) {
					return done(raw, false);
				}

				// A token session is told it may only infer, so the CLI never asks about plan limits.
				// Ask again with the scope declared; if the token really cannot read the profile the
				// second read returns no windows and nothing is lost but ~0.5s.
				const retried = await deps.readUsage({ ...readOptions, oauthScopes: PROFILE_SCOPES });
				const afterRetry = normalizeUsage({ ...retried, fetchedAtMs: Date.now() });
				if (!probeIfUnavailable || afterRetry.rateLimitsAvailable) return done(retried, true);

				// Last resort, and the only route left for an inference-only token: send one trivial
				// turn so the API response carries the rate-limit headers, which the CLI reports as
				// seeded utilisation. This one costs money — a fraction of a cent — which is why it is
				// opt-in and why the cost lands in the item's own session total.
				const probed = await deps.readUsage({
					...readOptions,
					oauthScopes: PROFILE_SCOPES,
					probePrompt: PROBE_PROMPT,
				});
				return done(probed, true);
			})();
			readsByPath.set(cacheKey, pending);
		}

		let read: CachedRead;
		try {
			read = await pending;
		} catch (error) {
			if (error instanceof UsageReadTimeoutError) {
				throw new NodeOperationError(ctx.getNode(), error.message, {
					itemIndex,
					description:
						error.stage === 'initialize'
							? 'The CLI started but never answered. A slow SessionStart hook in the working directory is the usual cause; raise the Timeout or point Project Path elsewhere.'
							: error.stage === 'probe'
								? 'The probe turn never finished, so there were no rate-limit headers to read. Raise the Timeout, or turn the probe off and accept the account data alone.'
								: 'The session answered but the usage request did not. Raise the Timeout and retry.',
				});
			}
			throw new NodeOperationError(
				ctx.getNode(),
				`Could not read Claude usage: ${error instanceof Error ? error.message : String(error)}`,
				{
					itemIndex,
					description:
						'The read needs a logged-in Claude CLI. Check that the n8n process can see ~/.claude — in Docker that means mounting it — or that ANTHROPIC_API_KEY is set, which yields account data without plan limits.',
				},
			);
		}

		const report: UsageReport = normalizeUsage({
			...read.raw,
			fetchedAtMs: read.fetchedAtMs,
			includeEmail: options.includeAccountEmail === true,
			includeRawLimits: options.includeRawLimits === true,
		});
		if (read.scopeRetried) report.diagnostics.scopeRetried = true;
		if (read.raw.probeCostUsd !== null) {
			report.diagnostics.probed = true;
			report.diagnostics.probeCostUsd = read.raw.probeCostUsd;
		}

		createDebugLogger(ctx.logger, options.debug === true).lazy('Claude Code usage read', () => ({
			projectPath: projectPath || '(default)',
			initMs: report.diagnostics.initMs,
			usageMs: report.diagnostics.usageMs,
			authenticated: report.authenticated,
			planLimitsApply: report.planLimitsApply,
			windowCount: report.windows.length,
			unknownBucketKeys: report.diagnostics.unknownBucketKeys,
			limitsPayloadMissing: report.diagnostics.limitsPayloadMissing,
			scopeRetried: read.scopeRetried,
			probeCostUsd: read.raw.probeCostUsd,
			unsupported: report.unsupported,
			reusedRead,
		}));

		if (options.errorIfLimitsUnavailable && !report.rateLimitsAvailable) {
			// Three different causes, three different fixes. An unauthenticated CLI is the one that
			// looks like success — it answers the control requests and simply reports no login.
			const description = !report.authenticated
				? 'The Claude CLI has no login (tokenSource "none"), so there is no account to read limits for. Run `claude login` as the user n8n runs as, or make its ~/.claude visible to the n8n process — in Docker that means mounting it.'
				: report.planLimitsApply
					? 'This account has plan limits, but the read came back without them — the usage endpoint answered empty. Retry rather than treating it as unlimited.'
					: report.account.tokenSource === 'CLAUDE_CODE_OAUTH_TOKEN'
						? 'This session authenticates with CLAUDE_CODE_OAUTH_TOKEN. Tokens from `claude setup-token` are inference-only by design, so the usage endpoint refuses them. Turn on "Probe With a Minimal Prompt If Unavailable" to read the 5-hour and 7-day windows off the rate-limit response headers instead — that costs about $0.001 per read. For the full payload, authenticate with an interactive `claude auth login` (keep ~/.claude on a volume) or a CLAUDE_CODE_OAUTH_REFRESH_TOKEN login.'
						: 'This session has no plan limits: API key, Bedrock and Vertex logins are billed per token instead. Turn this option off to accept that.';

			throw new NodeOperationError(ctx.getNode(), 'No plan limit windows were returned', {
				itemIndex,
				description,
			});
		}

		returnData.push({
			json: report as unknown as IDataObject,
			pairedItem: { item: itemIndex },
		});
	}

	return [returnData];
}
