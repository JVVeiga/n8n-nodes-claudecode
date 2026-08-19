import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import { statSync } from 'fs';
import { readUsage, UsageReadTimeoutError, type UsageReadResult } from './readUsage';
import { normalizeUsage, type UsageReport } from './usage';

type UsageOptions = {
	includeRawLimits?: boolean;
	includeAccountEmail?: boolean;
	errorIfLimitsUnavailable?: boolean;
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
		subtitle: '={{$parameter["operation"]}}',
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
		const readsByPath = new Map<string, Promise<{ raw: UsageReadResult; fetchedAtMs: number }>>();

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

			// Serialised rather than concatenated: a separator character could appear inside a path.
			const cacheKey = JSON.stringify([projectPath, executable, timeout]);
			let pending = readsByPath.get(cacheKey);
			if (!pending) {
				pending = readUsage({
					timeoutMs: Math.max(1, timeout) * 1000,
					...(projectPath ? { cwd: projectPath } : {}),
					...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
				}).then((raw) => ({ raw, fetchedAtMs: Date.now() }));
				readsByPath.set(cacheKey, pending);
			}

			let read: { raw: UsageReadResult; fetchedAtMs: number };
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

			if (options.debug) {
				this.logger.debug('Claude Code usage read', {
					projectPath: projectPath || '(default)',
					initMs: report.diagnostics.initMs,
					usageMs: report.diagnostics.usageMs,
					planLimitsApply: report.planLimitsApply,
					windowCount: report.windows.length,
					unknownBucketKeys: report.diagnostics.unknownBucketKeys,
					limitsPayloadMissing: report.diagnostics.limitsPayloadMissing,
					unsupported: report.unsupported,
					reusedRead: readsByPath.size < itemIndex + 1,
				});
			}

			if (options.errorIfLimitsUnavailable && !report.rateLimitsAvailable) {
				throw new NodeOperationError(this.getNode(), 'No plan limit windows were returned', {
					itemIndex,
					description: report.planLimitsApply
						? 'This account has plan limits, but the read came back without them — the usage endpoint answered empty. Retry rather than treating it as unlimited.'
						: 'This session has no plan limits: API key, Bedrock and Vertex logins are billed per token instead. Turn this option off to accept that.',
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
