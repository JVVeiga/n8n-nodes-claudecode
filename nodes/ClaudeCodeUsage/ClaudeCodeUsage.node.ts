import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import { statSync } from 'fs';
import {
	PROBE_PROMPT,
	PROFILE_SCOPES,
	readUsage,
	UsageReadTimeoutError,
	type UsageReadResult,
} from './readUsage';
import { normalizeUsage, shouldRetryWithProfileScope, type UsageReport } from './usage';

type UsageOptions = {
	includeRawLimits?: boolean;
	includeAccountEmail?: boolean;
	errorIfLimitsUnavailable?: boolean;
	declareProfileScope?: boolean;
	probeIfUnavailable?: boolean;
	debug?: boolean;
	pathToClaudeCodeExecutable?: string;
};

export class ClaudeCodeUsage implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Claude Code Usage',
		name: 'claudeCodeUsage',
		icon: 'file:claudecodeusage.svg',
		group: ['transform'],
		version: 1,
		// No subtitle: with a single operation it renders the raw value ("getUsage") under the node
		// name on the canvas, which says nothing the name has not already said.
		description:
			'Read the logged-in account and how much of its Claude plan is left, including when each window resets',
		usableAsTool: true,
		defaults: {
			name: 'Claude Code Usage',
		},
		inputs: [{ type: NodeConnectionType.Main }],
		outputs: [{ type: NodeConnectionType.Main }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Get Usage',
						value: 'getUsage',
						description: 'Read account, plan utilisation and reset windows',
						action: 'Get plan usage limits and reset windows',
					},
				],
				default: 'getUsage',
			},
			{
				displayName: 'Project Path',
				name: 'projectPath',
				type: 'string',
				default: '',
				description:
					'The directory the read runs in. Authentication is account-wide, but settings, env and hooks resolve per directory, so a path with slow SessionStart hooks makes the read slower. If empty, uses the current working directory.',
				placeholder: '/home/user/projects/my-app',
			},
			{
				displayName: 'Timeout',
				name: 'timeout',
				type: 'number',
				default: 60,
				description:
					'Maximum time to wait for the read (in seconds), covering CLI startup, hooks and both control requests. A read normally takes 1-3 seconds.',
			},
			{
				displayName: 'Options',
				name: 'usageOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Debug Mode',
						name: 'debug',
						type: 'boolean',
						default: false,
						description: 'Whether to enable debug logging',
					},
					{
						displayName: 'Declare Profile Scope for Token Sessions',
						name: 'declareProfileScope',
						type: 'boolean',
						default: true,
						description:
							'Whether to retry the read declaring CLAUDE_CODE_OAUTH_SCOPES when the session authenticates with CLAUDE_CODE_OAUTH_TOKEN. Such a session gets a synthesised scope list of user:inference alone, and the CLI requires user:profile before it will look up plan limits at all. Declaring the scope grants nothing the token does not already have — a setup-token is inference-only by design and the server will refuse, which shows up as limitsPayloadMissing. Worth leaving on: it costs one extra read only on token sessions, and it does recover the numbers when a stored login is also present.',
					},
					{
						displayName: 'Error If Limits Unavailable',
						name: 'errorIfLimitsUnavailable',
						type: 'boolean',
						default: false,
						description:
							'Whether to fail the item when the read returns no plan windows. Off by default because an API key, Bedrock or Vertex session legitimately has none. Turn on when the workflow gates on capacity and running blind is worse than failing.',
					},
					{
						displayName: 'Include Account Email',
						name: 'includeAccountEmail',
						type: 'boolean',
						default: false,
						description:
							'Whether to include the logged-in email in the output. Off by default: the organisation and plan already identify the account, and n8n saves the output with every execution.',
					},
					{
						displayName: 'Include Raw Limits',
						name: 'includeRawLimits',
						type: 'boolean',
						default: false,
						description:
							"Whether to add limitsRaw, the server's own limits array with kind, group, severity, scope and is_active. Not merged into the windows: matching the two by reset timestamp would be guesswork.",
					},
					{
						displayName: 'Path to Claude Code Executable',
						name: 'pathToClaudeCodeExecutable',
						type: 'string',
						default: '',
						description:
							'Absolute path to the Claude Code CLI. Leave empty to use the one bundled with the SDK.',
						placeholder: '/usr/local/bin/claude',
					},
					{
						displayName: 'Probe With a Minimal Prompt If Unavailable',
						name: 'probeIfUnavailable',
						type: 'boolean',
						default: false,
						description:
							'Whether to fall back to sending one trivial turn when no plan windows come back. Every API response carries anthropic-ratelimit-unified headers, and the CLI reports those as utilisation when the usage endpoint is closed to the credential — which is the only route to the numbers for an inference-only CLAUDE_CODE_OAUTH_TOKEN. Off by default because it is the one thing here that costs money: measured around $0.001 per read on Haiku, and the exact amount shows up in the item under session.totalCostUsd and diagnostics.probeCostUsd. Only the 5-hour and 7-day windows arrive this way; extra usage and per-model buckets come from the endpoint alone.',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
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
			const projectPath = (this.getNodeParameter('projectPath', itemIndex) as string).trim();
			const timeout = this.getNodeParameter('timeout', itemIndex) as number;
			const options = this.getNodeParameter('usageOptions', itemIndex, {}) as UsageOptions;
			const executable = (options.pathToClaudeCodeExecutable ?? '').trim();

			// Validate before spawning: the SDK's spawn-error handler blames a libc/architecture
			// mismatch for the ENOENT a missing cwd produces, which sends users chasing a phantom.
			if (projectPath !== '') {
				let isDirectory = false;
				try {
					isDirectory = statSync(projectPath).isDirectory();
				} catch {
					isDirectory = false;
				}
				if (!isDirectory) {
					throw new NodeOperationError(
						this.getNode(),
						`Project Path is not an existing directory: ${projectPath}`,
						{
							itemIndex,
							description:
								'The path must exist inside the n8n container. If n8n runs in Docker, make sure the directory is mounted into it.',
						},
					);
				}
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
			if (!pending) {
				const readOptions = {
					timeoutMs: Math.max(1, timeout) * 1000,
					...(projectPath ? { cwd: projectPath } : {}),
					...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
				};

				// The escalation lives inside the cached promise so a batch pays for it once, and every
				// item reports the same numbers and the same fetchedAt.
				pending = (async (): Promise<CachedRead> => {
					const raw = await readUsage(readOptions);
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
					const retried = await readUsage({ ...readOptions, oauthScopes: PROFILE_SCOPES });
					const afterRetry = normalizeUsage({ ...retried, fetchedAtMs: Date.now() });
					if (!probeIfUnavailable || afterRetry.rateLimitsAvailable) return done(retried, true);

					// Last resort, and the only route left for an inference-only token: send one trivial
					// turn so the API response carries the rate-limit headers, which the CLI reports as
					// seeded utilisation. This one costs money — a fraction of a cent — which is why it is
					// opt-in and why the cost lands in the item's own session total.
					const probed = await readUsage({
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
					throw new NodeOperationError(this.getNode(), error.message, {
						itemIndex,
						description:
							error.stage === 'initialize'
								? 'The CLI started but never answered. A slow SessionStart hook in the working directory is the usual cause; raise the Timeout or point Project Path elsewhere.'
								: 'The session answered but the usage request did not. Raise the Timeout and retry.',
					});
				}
				throw new NodeOperationError(
					this.getNode(),
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

			if (options.debug) {
				this.logger.debug('Claude Code usage read', {
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
					reusedRead: readsByPath.size < itemIndex + 1,
				});
			}

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

				throw new NodeOperationError(this.getNode(), 'No plan limit windows were returned', {
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
}
