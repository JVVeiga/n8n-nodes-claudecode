import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { readUsage, UsageReadTimeoutError } from './readUsage';
import { normalizeUsage, type UsageReport } from './usage';
import { applyReadDiagnostics, escalateUsageRead, type EscalatedRead } from './escalate';
import { createHash } from 'crypto';
import { buildAuthEnv } from '../shared/auth';
import { readAuth } from '../shared/readAuth';
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
	type CachedRead = EscalatedRead;
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

		const authOutcome = await readAuth(ctx, itemIndex);
		if ('problem' in authOutcome) {
			throw new NodeOperationError(ctx.getNode(), authOutcome.problem.message, {
				itemIndex,
				description: authOutcome.problem.description,
			});
		}
		const authEnv = buildAuthEnv(authOutcome.auth, process.env);

		const declareProfileScope = options.declareProfileScope !== false;
		const probeIfUnavailable = options.probeIfUnavailable === true;

		// Two items on different credentials describe different accounts, so the read cache has to
		// partition on the credential as well. The secret is reduced to a digest rather than put in
		// the key: nothing needs to read it back, and a value that never exists in full cannot be
		// leaked by something that later decides to log a cache key.
		const authKey = authEnv
			? `${authOutcome.auth.mode}:${createHash('sha256')
					.update((authOutcome.auth as { secret: string }).secret)
					.digest('hex')}`
			: 'host';

		// Serialised rather than concatenated: a separator character could appear inside a path.
		const cacheKey = JSON.stringify([
			projectPath,
			executable,
			timeout,
			declareProfileScope,
			probeIfUnavailable,
			authKey,
		]);
		let pending = readsByPath.get(cacheKey);
		const reusedRead = pending !== undefined;
		if (!pending) {
			const readOptions = {
				timeoutMs: Math.max(1, timeout) * 1000,
				...(projectPath ? { cwd: projectPath } : {}),
				...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
				...(authEnv ? { authEnv } : {}),
			};

			// The escalation lives inside the cached promise so a batch pays for it once, and every
			// item reports the same numbers and the same fetchedAt.
			// The escalation lives inside the cached promise so a batch pays for it once, and every
			// item reports the same numbers and the same fetchedAt. The steps themselves are in
			// escalate.ts, shared with the Usage Tool so the two cannot drift.
			pending = escalateUsageRead(deps.readUsage, readOptions, {
				declareProfileScope,
				probeIfUnavailable,
			});
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
		applyReadDiagnostics(report, read);

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
