import type { INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionType } from 'n8n-workflow';
import { FALLBACK_MODEL_OPTIONS, MODEL_OPTIONS } from './models';
import { BUILT_IN_TOOL_OPTIONS } from './toolOptions';

/**
 * The node's declarative schema: ~350 lines of pure data with no branching in it. It lived inside
 * the class, immediately above an 876-line execute(), so reaching any logic meant scrolling past
 * the entire UI definition. Nothing here executes; keeping it separate is what lets the node file
 * be read in one sitting.
 */
export const claudeCodeDescription: INodeTypeDescription = {
	displayName: 'Claude Code',
	name: 'claudeCode',
	icon: 'file:claudecode.svg',
	group: ['transform'],
	// Each version changes observable behaviour, so a node stays where it was created until its
	// author opts in:
	//
	//   1.1  Timeout Wrap-Up Grace defaults to 60s instead of 0, and failure items are reshaped
	//        so they reach the error output branch.
	//   1.2  One output envelope for all three formats. Metrics always under `metrics`; an
	//        unknown cost reports null rather than 0; `messages` carries metrics too; a tool
	//        use counts wherever it appears in a turn, not only as the first content block; the
	//        metrics come from the LAST result message rather than the first, which matters on
	//        a graceful timeout; and `errorText` is separate from `result`. See output/v12.ts.
	version: [1, 1.1, 1.2],
	defaultVersion: 1.2,
	subtitle: '={{$parameter["operation"] + ": " + $parameter["prompt"]}}',
	description:
		'Use Claude Code SDK to execute AI-powered coding tasks with customizable tool support',
	usableAsTool: true,
	defaults: {
		name: 'Claude Code',
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
					name: 'Query',
					value: 'query',
					description: 'Start a new conversation with Claude Code',
					action: 'Start a new conversation with claude code',
				},
				{
					name: 'Continue',
					value: 'continue',
					description: 'Continue a previous conversation (requires prior query)',
					action: 'Continue a previous conversation requires prior query',
				},
			],
			default: 'query',
		},
		{
			displayName: 'Prompt',
			name: 'prompt',
			type: 'string',
			typeOptions: {
				rows: 4,
			},
			default: '',
			description: 'The prompt or instruction to send to Claude Code',
			required: true,
			placeholder: 'e.g., "Create a Python function to parse CSV files"',
			hint: 'Use expressions like {{$json.prompt}} to use data from previous nodes',
		},
		{
			displayName: 'Session ID',
			name: 'sessionId',
			type: 'string',
			default: '',
			displayOptions: { show: { operation: ['continue'] } },
			description:
				"Resume this specific session, taken from a previous run's diagnostics.sessionId. Leave empty to continue the most recent conversation in the working directory — which every execution on this instance shares, so concurrent runs will collide.",
			placeholder: 'e.g. 0b7f2c1e-...',
		},
		{
			displayName: 'Model',
			name: 'model',
			type: 'options',
			// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
			// Aliases first, then pinned IDs newest-first — see description/models.ts.
			options: MODEL_OPTIONS,
			default: 'sonnet',
			description:
				'Claude model to use. Aliases auto-resolve to the latest version; pinned IDs stay fixed.',
		},
		{
			displayName: 'Effort',
			name: 'effort',
			type: 'options',
			// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
			options: [
				{ name: 'Low', value: 'low', description: 'Minimal thinking, fastest responses' },
				{ name: 'Medium', value: 'medium', description: 'Moderate thinking' },
				{ name: 'High', value: 'high', description: 'Deep reasoning (recommended default)' },
				{
					name: 'xHigh',
					value: 'xhigh',
					description: 'Best for most coding and agentic tasks (Opus 4.7+, Sonnet 5)',
				},
				{
					name: 'Max',
					value: 'max',
					description: 'Maximum effort when correctness matters more than cost',
				},
				{
					name: 'Ultracode (xHigh + Workflows)',
					value: 'ultracode',
					description:
						'Standing dynamic multi-agent workflow orchestration (the Workflow tool) on top of xHigh effort. Requires an xHigh-capable model (Opus 4.7+/Sonnet 5). Best for large, decomposable tasks.',
				},
			],
			default: 'high',
			description:
				'Reasoning effort — controls how much thinking Claude applies. Ultracode adds standing dynamic-workflow orchestration on top of xHigh. Silently downgraded on models that don’t support the selected level.',
		},
		{
			displayName: 'Max Turns',
			name: 'maxTurns',
			type: 'number',
			default: 25,
			description:
				'Maximum number of conversation turns (back-and-forth exchanges) allowed. Complex tasks may require more turns.',
		},
		{
			displayName: 'Timeout',
			name: 'timeout',
			type: 'number',
			default: 300,
			description:
				'Maximum time to wait for completion (in seconds) before aborting. Applies per input item, so a node processing N items can run for up to N times this long.',
		},
		{
			displayName: 'Project Path',
			name: 'projectPath',
			type: 'string',
			default: '',
			description:
				'The directory path where Claude Code should run (e.g., /path/to/project). If empty, uses the current working directory.',
			placeholder: '/home/user/projects/my-app',
			hint: 'This sets the working directory for Claude Code, allowing it to access files and run commands in the specified project location',
		},
		{
			displayName: 'Output Format',
			name: 'outputFormat',
			type: 'options',
			noDataExpression: true,
			options: [
				{
					name: 'Structured',
					value: 'structured',
					description: 'Returns a structured object with messages, summary, result, and metrics',
				},
				{
					name: 'Messages',
					value: 'messages',
					description: 'Returns the raw array of all messages exchanged',
				},
				{
					name: 'Text',
					value: 'text',
					description: 'Returns only the final result text',
				},
			],
			default: 'structured',
			description: 'Choose how to format the output data',
		},
		{
			displayName: 'Allowed Tools',
			name: 'allowedTools',
			type: 'multiOptions',
			options: BUILT_IN_TOOL_OPTIONS,
			default: ['WebFetch', 'TodoWrite', 'WebSearch', 'Task'],
			description:
				'Pre-approve these tools so they run without a permission prompt. This does NOT restrict anything — unlisted tools stay available. To block a tool, use Disallowed Tools, which removes it from the model entirely.',
		},
		{
			displayName: 'Disallowed Tools',
			name: 'disallowedTools',
			type: 'multiOptions',
			options: BUILT_IN_TOOL_OPTIONS,
			default: [],
			description:
				'Select which built-in tools Claude Code is explicitly blocked from using. Takes precedence over Allowed Tools.',
		},
		{
			displayName: 'Restrict Built-in Tools',
			name: 'restrictTools',
			type: 'multiOptions',
			options: BUILT_IN_TOOL_OPTIONS,
			default: [],
			description:
				'Limit Claude Code to this base set of built-in tools — everything else is never loaded. Leave empty for the full set. This is the real allowlist; Allowed Tools only pre-approves. Note: list Grep and Glob explicitly or search falls back to Bash.',
		},
		{
			displayName: 'Additional Options',
			name: 'additionalOptions',
			type: 'collection',
			placeholder: 'Add Option',
			default: {},
			// eslint-disable-next-line n8n-nodes-base/node-param-collection-type-unsorted-items
			options: [
				{
					displayName: 'Claude Code Executable Path',
					name: 'pathToClaudeCodeExecutable',
					type: 'string',
					default: '',
					placeholder: '/usr/local/bin/claude',
					description:
						'Absolute path to a Claude Code CLI binary to use instead of the one bundled with the SDK (e.g. a globally installed "claude"). Leave empty to use the bundled executable.',
				},
				{
					displayName: 'Debug Mode',
					name: 'debug',
					type: 'boolean',
					default: false,
					description: 'Whether to enable debug logging',
				},
				{
					displayName: 'Allow Plan Execution',
					name: 'allowPlanExecution',
					type: 'boolean',
					default: false,
					displayOptions: { show: { permissionMode: ['plan'] } },
					description:
						'Whether Claude may leave planning mode and carry the plan out. Plan mode alone never exposes an exit tool, so the run ends with a plan and nothing written.',
				},
				{
					displayName: 'Include Raw Transcript',
					name: 'includeTranscript',
					type: 'boolean',
					default: true,
					description:
						'Whether to embed the full message transcript in the output. It carries every tool result verbatim — file contents, command output — and n8n stores it with the execution. Turn off to keep only the summary, result and metrics.',
				},
				{
					displayName: 'Timeout Wrap-Up Grace (Seconds)',
					name: 'wrapUpGraceSeconds',
					type: 'number',
					default: 60,
					typeOptions: { minValue: 0, maxValue: 600 },
					description:
						'Seconds reserved at the end of the Timeout for Claude to stop and summarise what it did. Taken out of the Timeout, not added to it, so a run never exceeds the Timeout. Interrupting this way is what makes the SDK report the tokens, cost and session ID of a timed-out run — a plain kill reports none of it. Set to 0 to kill the process at the Timeout instead. Defaults to 60 on node version 1.1 and to 0 on version 1.',
				},
				{
					displayName: 'Max Budget (USD)',
					name: 'maxBudgetUsd',
					type: 'number',
					default: 0,
					typeOptions: { minValue: 0, numberPrecision: 4 },
					description:
						'Hard spend cap for a single run. The query stops once it is exceeded and returns an error result. Set to 0 to disable. Max Turns and Timeout bound length, not cost.',
				},
				{
					displayName: 'Fallback Model',
					name: 'fallbackModel',
					type: 'options',
					// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
					// Same list as Model, plus None — see description/models.ts.
					options: FALLBACK_MODEL_OPTIONS,
					default: '',
					description: 'Automatically switch to fallback model when primary model is overloaded',
				},
				{
					displayName: 'Thinking',
					name: 'thinking',
					type: 'options',
					// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
					options: [
						{
							name: 'Default (Model/Effort Decides)',
							value: '',
							description: 'Let the model and effort level decide; reasoning text stays hidden',
						},
						{
							name: 'Adaptive',
							value: 'adaptive',
							description: 'Claude decides when and how much to think; reasoning text stays hidden',
						},
						{
							name: 'Adaptive (Show Summary)',
							value: 'summarized',
							description:
								'Adaptive thinking with a readable summary of the reasoning included in the output messages',
						},
						{ name: 'Off', value: 'disabled', description: 'Disable extended thinking' },
					],
					default: '',
					description:
						'Control extended/adaptive thinking. Takes precedence over Max Thinking Tokens. On recent models budget-based thinking is unsupported — use Effort to tune depth.',
				},
				{
					displayName: 'Max Thinking Tokens',
					name: 'maxThinkingTokens',
					type: 'number',
					default: 0,
					description: 'Maximum number of thinking tokens (0 for unlimited)',
					hint: 'Controls how many tokens Claude can use for internal reasoning',
				},
				{
					displayName: 'Permission Mode',
					name: 'permissionMode',
					type: 'options',
					options: [
						{
							name: 'Accept Edits',
							value: 'acceptEdits',
							description: 'Automatically accept file edits',
						},
						{
							name: 'Auto',
							value: 'auto',
							description: 'Let Claude Code decide, without prompting',
						},
						{
							name: 'Bypass Permissions',
							value: 'bypassPermissions',
							description: 'Skip all permission checks',
						},
						{
							name: 'Default',
							value: 'default',
							description:
								'Standard permission prompts. Headless runs cannot answer them, so anything not pre-approved is denied.',
						},
						{
							name: "Don't Ask",
							value: 'dontAsk',
							description:
								'Never prompt. Tools that are pre-approved in Allowed Tools run; anything else is denied.',
						},
						{
							name: 'Plan',
							value: 'plan',
							description:
								'Planning mode - Claude produces a plan and executes no tools. Nothing is written.',
						},
					],
					default: 'bypassPermissions',
					description:
						"How to handle permission requests for tool usage. Bypass Permissions is the default because n8n runs headless and cannot answer a prompt; pair Don't Ask with Allowed Tools for a bounded run.",
				},
				{
					displayName: 'System Prompt',
					name: 'systemPrompt',
					type: 'string',
					typeOptions: {
						rows: 4,
					},
					default: '',
					description: 'Additional context or instructions for Claude Code',
					placeholder:
						'You are helping with a Python project. Focus on clean, readable code with proper error handling.',
				},
			],
		},
	],
};
