import type { INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionType } from 'n8n-workflow';

/**
 * The Usage node's declarative schema. Split out for the same reason the Claude Code node's was:
 * it is pure data, and keeping it above execute() meant scrolling past the whole UI to reach any
 * logic.
 */
export const claudeCodeUsageDescription: INodeTypeDescription = {
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
