import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import { statSync } from 'fs';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createPromptStream } from './promptStream';
import { resolveGraceWindow } from './timeout';

/**
 * Built-in Claude Code tools (v2). The exact set varies by CLI version and
 * environment; unknown names are simply ignored. Shared by every tool
 * selector so the lists cannot drift apart.
 */
const BUILT_IN_TOOL_OPTIONS = [
	{ name: 'Artifact', value: 'Artifact', description: 'Publish an artifact page' },
	{ name: 'Bash', value: 'Bash', description: 'Execute bash commands' },
	{ name: 'CronCreate', value: 'CronCreate', description: 'Create a scheduled job' },
	{ name: 'CronDelete', value: 'CronDelete', description: 'Delete a scheduled job' },
	{ name: 'CronList', value: 'CronList', description: 'List scheduled jobs' },
	{ name: 'DesignSync', value: 'DesignSync', description: 'Sync design assets' },
	{ name: 'Edit', value: 'Edit', description: 'Edit files' },
	{ name: 'EnterWorktree', value: 'EnterWorktree', description: 'Enter a git worktree' },
	{ name: 'ExitWorktree', value: 'ExitWorktree', description: 'Exit a git worktree' },
	{ name: 'Glob', value: 'Glob', description: 'Find files by pattern' },
	{ name: 'Grep', value: 'Grep', description: 'Search file contents' },
	{ name: 'Monitor', value: 'Monitor', description: 'Watch a command or condition' },
	{ name: 'NotebookEdit', value: 'NotebookEdit', description: 'Edit Jupyter notebooks' },
	{
		name: 'PushNotification',
		value: 'PushNotification',
		description: 'Send a notification',
	},
	{ name: 'Read', value: 'Read', description: 'Read file contents' },
	{ name: 'RemoteTrigger', value: 'RemoteTrigger', description: 'Trigger a remote agent' },
	{
		name: 'ReportFindings',
		value: 'ReportFindings',
		description: 'Report review findings',
	},
	{ name: 'ScheduleWakeup', value: 'ScheduleWakeup', description: 'Schedule a wake-up' },
	{ name: 'SendMessage', value: 'SendMessage', description: 'Message a running agent' },
	{ name: 'Skill', value: 'Skill', description: 'Invoke a skill' },
	{ name: 'Task', value: 'Task', description: 'Launch subagents for complex work' },
	{ name: 'TaskCreate', value: 'TaskCreate', description: 'Create a background task' },
	{ name: 'TaskGet', value: 'TaskGet', description: 'Get a background task' },
	{ name: 'TaskList', value: 'TaskList', description: 'List background tasks' },
	{ name: 'TaskOutput', value: 'TaskOutput', description: 'Read background task output' },
	{ name: 'TaskStop', value: 'TaskStop', description: 'Stop a background task' },
	{ name: 'TaskUpdate', value: 'TaskUpdate', description: 'Update a background task' },
	{ name: 'TodoWrite', value: 'TodoWrite', description: 'Manage todo lists' },
	{ name: 'ToolSearch', value: 'ToolSearch', description: 'Discover deferred tools' },
	{ name: 'WebFetch', value: 'WebFetch', description: 'Fetch web content' },
	{ name: 'WebSearch', value: 'WebSearch', description: 'Search the web' },
	{
		name: 'Workflow',
		value: 'Workflow',
		description: 'Run dynamic multi-agent workflows (required for Ultracode)',
	},
	{ name: 'Write', value: 'Write', description: 'Write files' },
];

export class ClaudeCode implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Claude Code',
		name: 'claudeCode',
		icon: 'file:claudecode.svg',
		group: ['transform'],
		// 1.1 changes two observable behaviours, so existing nodes stay on 1 until their author
		// opts in: Timeout Wrap-Up Grace defaults to 60s instead of 0 (a run is interrupted and
		// asked to summarise before the hard abort), and failure items carry the top-level `error`
		// field n8n needs to route them to the error output branch.
		version: [1, 1.1],
		defaultVersion: 1.1,
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
				options: [
					{
						name: 'Sonnet (Latest Alias)',
						value: 'sonnet',
						description: 'Auto-resolves to the latest Sonnet — balanced speed and intelligence',
					},
					{
						name: 'Opus (Latest Alias)',
						value: 'opus',
						description: 'Auto-resolves to the latest Opus — most capable for complex tasks',
					},
					{
						name: 'Haiku (Latest Alias)',
						value: 'haiku',
						description: 'Auto-resolves to the latest Haiku — fastest and most cost-effective',
					},
					{
						name: 'Opus 5',
						value: 'claude-opus-5',
						description: 'Latest and most capable Opus model',
					},
					{
						name: 'Opus 4.8',
						value: 'claude-opus-4-8',
						description: 'Previous-generation Opus, state-of-the-art agentic work',
					},
					{
						name: 'Opus 4.7',
						value: 'claude-opus-4-7',
						description: 'Previous-generation Opus, highly autonomous',
					},
					{
						name: 'Sonnet 5',
						value: 'claude-sonnet-5',
						description: 'Near-Opus quality on coding/agentic work at Sonnet cost',
					},
					{
						name: 'Haiku 4.5',
						value: 'claude-haiku-4-5',
						description: 'Fast and cost-effective for simpler tasks',
					},
					{
						name: 'Fable 5',
						value: 'claude-fable-5',
						description: 'Anthropic’s most capable model for demanding long-horizon work',
					},
				],
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
						options: [
							{ name: 'None', value: '', description: 'No fallback model' },
							{
								name: 'Sonnet (Latest Alias)',
								value: 'sonnet',
								description: 'Fallback to latest Sonnet',
							},
							{
								name: 'Opus (Latest Alias)',
								value: 'opus',
								description: 'Fallback to latest Opus',
							},
							{
								name: 'Haiku (Latest Alias)',
								value: 'haiku',
								description: 'Fallback to latest Haiku',
							},
							{ name: 'Opus 5', value: 'claude-opus-5', description: 'Fallback to Opus 5' },
							{ name: 'Opus 4.8', value: 'claude-opus-4-8', description: 'Fallback to Opus 4.8' },
							{ name: 'Sonnet 5', value: 'claude-sonnet-5', description: 'Fallback to Sonnet 5' },
							{
								name: 'Haiku 4.5',
								value: 'claude-haiku-4-5',
								description: 'Fallback to Haiku 4.5',
							},
						],
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
								description:
									'Claude decides when and how much to think; reasoning text stays hidden',
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

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			let timeout = 300; // Default timeout
			let timedOut = false;
			// Declared per item and outside the try blocks so every error path can
			// still report what ran and what it cost.
			const messages: SDKMessage[] = [];
			let diagnostics: Record<string, unknown> | null = null;
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const rawPrompt = this.getNodeParameter('prompt', itemIndex) as string;
				const model = this.getNodeParameter('model', itemIndex) as string;
				const effort = this.getNodeParameter('effort', itemIndex, 'high') as
					| 'low'
					| 'medium'
					| 'high'
					| 'xhigh'
					| 'max'
					| 'ultracode';
				// Ultracode is the top of the effort selector (matches Claude Code's own UI):
				// it means xHigh effort plus standing dynamic-workflow orchestration.
				const ultracode = effort === 'ultracode';
				const maxTurns = this.getNodeParameter('maxTurns', itemIndex) as number;
				timeout = this.getNodeParameter('timeout', itemIndex) as number;
				const projectPath = this.getNodeParameter('projectPath', itemIndex) as string;
				const outputFormat = this.getNodeParameter('outputFormat', itemIndex) as string;
				const allowedTools = this.getNodeParameter('allowedTools', itemIndex, []) as string[];
				const disallowedTools = this.getNodeParameter('disallowedTools', itemIndex, []) as string[];
				const restrictTools = this.getNodeParameter('restrictTools', itemIndex, []) as string[];
				const additionalOptions = this.getNodeParameter('additionalOptions', itemIndex) as {
					systemPrompt?: string;
					permissionMode?: string;
					debug?: boolean;
					fallbackModel?: string;
					maxThinkingTokens?: number;
					maxBudgetUsd?: number;
					includeTranscript?: boolean;
					allowPlanExecution?: boolean;
					pathToClaudeCodeExecutable?: string;
					thinking?: string;
					wrapUpGraceSeconds?: number;
				};

				// The declarative schema cannot vary a default by typeVersion, and the field lives
				// inside a collection — so an unset field arrives as undefined and the version-aware
				// fallback is applied here. v1 keeps the 0.7.2 behaviour of a plain kill at the
				// timeout, with no wrap-up and therefore no spend reporting.
				const nodeVersion = this.getNode().typeVersion;
				const graceWindow = resolveGraceWindow(
					timeout,
					additionalOptions.wrapUpGraceSeconds ?? (nodeVersion >= 1.1 ? 60 : 0),
				);

				// Validate required parameters before arming the timer, so a rejected
				// prompt cannot leak a pending timeout handle.
				if (!rawPrompt || rawPrompt.trim() === '') {
					throw new NodeOperationError(this.getNode(), 'Prompt is required and cannot be empty', {
						itemIndex,
					});
				}

				// Create abort controller for timeout
				const abortController = new AbortController();
				const timeoutMs = timeout * 1000;
				const timeoutId = setTimeout(() => {
					timedOut = true;
					abortController.abort();
				}, timeoutMs);

				// Stopping the n8n execution must also stop the agent. Without this the
				// spawned Claude Code process keeps running — and keeps spending — until
				// its own timeout, with its output discarded.
				this.onExecutionCancellation(() => abortController.abort());

				// Delivered as a stream, not a string: control requests such as interrupt() are only
				// available in streaming input mode. The stream must be closed once the run is done
				// or the SDK keeps the session open and the query never ends.
				const promptStream = createPromptStream(rawPrompt);
				const prompt = rawPrompt;

				// Ultracode maps to xHigh effort (its defined level) plus the
				// settings.ultracode session flag applied below. All other selections
				// pass through unchanged.
				const effectiveEffort = effort === 'ultracode' ? 'xhigh' : effort;

				// Log start
				if (additionalOptions.debug) {
					this.logger.debug('Starting Claude Code execution', {
						itemIndex,
						prompt: prompt.substring(0, 100) + '...',
						model,
						maxTurns,
						timeout: `${timeout}s`,
						nodeVersion,
						wrapUpGraceSeconds: graceWindow.graceSeconds,
						wrapUpAtMs: graceWindow.wrapUpAtMs,
						hardAbortAtMs: graceWindow.hardAbortAtMs,
						allowedTools,
						disallowedTools,
						fallbackModel: additionalOptions.fallbackModel || 'none',
					});
				}

				// Build query options
				interface QueryOptions {
					prompt: AsyncIterable<SDKUserMessage>;
					options: {
						abortController: AbortController;
						maxTurns: number;
						permissionMode:
							| 'default'
							| 'acceptEdits'
							| 'bypassPermissions'
							| 'plan'
							| 'dontAsk'
							| 'auto';
						canUseTool?: (
							toolName: string,
							input: Record<string, unknown>,
						) => Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> }>;
						model: string;
						effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
						systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
						mcpServers?: Record<string, any>;
						tools?: string[];
						allowedTools?: string[];
						disallowedTools?: string[];
						fallbackModel?: string;
						maxThinkingTokens?: number;
						maxBudgetUsd?: number;
						continue?: boolean;
						resume?: string;
						cwd?: string;
						pathToClaudeCodeExecutable?: string;
						thinking?: { type: 'adaptive' | 'disabled'; display?: 'summarized' };
						settings?: { ultracode?: boolean };
						hooks?: any;
					};
				}

				const queryOptions: QueryOptions = {
					prompt: promptStream.stream,
					options: {
						abortController,
						maxTurns,
						permissionMode: (additionalOptions.permissionMode || 'bypassPermissions') as any,
						model,
						effort: effectiveEffort,
					},
				};

				// Plan mode exposes no exit tool unless a permission callback is
				// registered, so on its own it always ends with a plan and nothing
				// written. Registering one lets Claude leave plan mode and act.
				if (
					queryOptions.options.permissionMode === 'plan' &&
					additionalOptions.allowPlanExecution
				) {
					queryOptions.options.canUseTool = async (_toolName, input) => ({
						behavior: 'allow',
						updatedInput: input,
					});
				}

				// Enable Ultracode as a real session setting: standing dynamic-workflow
				// orchestration at xhigh effort (requires an xhigh-capable model + workflows).
				if (ultracode) {
					queryOptions.options.settings = { ultracode: true };
				}

				// Capture the effort level Claude Code actually applies (post-downgrade).
				// It is exposed only inside hooks, not in the message stream; Stop/SubagentStop
				// fire at end of turn so plain replies (no tool use) are covered too.
				let appliedEffort: string | undefined;
				const captureEffort = async (input: any) => {
					const level = input?.effort?.level;
					if (level) appliedEffort = level;
					return { continue: true };
				};
				queryOptions.options.hooks = {
					PreToolUse: [{ hooks: [captureEffort] }],
					PostToolUse: [{ hooks: [captureEffort] }],
					Stop: [{ hooks: [captureEffort] }],
					SubagentStop: [{ hooks: [captureEffort] }],
				};

				// Append the user-provided system prompt to Claude Code's default preset
				// (rather than replacing it), preserving the built-in agent behavior.
				if (additionalOptions.systemPrompt) {
					queryOptions.options.systemPrompt = {
						type: 'preset',
						preset: 'claude_code',
						append: additionalOptions.systemPrompt,
					};
				}

				// Use a custom Claude Code executable if provided (e.g. a globally
				// installed CLI) instead of the one bundled with the SDK.
				if (additionalOptions.pathToClaudeCodeExecutable?.trim()) {
					queryOptions.options.pathToClaudeCodeExecutable =
						additionalOptions.pathToClaudeCodeExecutable.trim();
				}

				// Add project path (cwd) if specified. Validate it first: the SDK's
				// spawn-error handler blames a libc/architecture mismatch for the ENOENT
				// a missing cwd produces, which sends users chasing a phantom problem.
				if (projectPath && projectPath.trim() !== '') {
					const cwd = projectPath.trim();
					let isDirectory = false;
					try {
						isDirectory = statSync(cwd).isDirectory();
					} catch {
						isDirectory = false;
					}
					if (!isDirectory) {
						throw new NodeOperationError(
							this.getNode(),
							`Project Path is not an existing directory: ${cwd}`,
							{
								itemIndex,
								description:
									'The path must exist inside the n8n container. If n8n runs in Docker, make sure the directory is mounted into it.',
							},
						);
					}
					queryOptions.options.cwd = cwd;
					if (additionalOptions.debug) {
						this.logger.debug('Working directory set', { cwd: queryOptions.options.cwd });
					}
				}

				// Restrict Built-in Tools is the real allowlist: an empty selection keeps
				// the full set. Ultracode needs Workflow and Task, so add them rather
				// than let a restriction silently disable orchestration.
				const effectiveTools =
					ultracode && restrictTools.length > 0
						? Array.from(new Set([...restrictTools, 'Workflow', 'Task']))
						: restrictTools;

				if (effectiveTools.length > 0) {
					queryOptions.options.tools = effectiveTools;
					if (additionalOptions.debug) {
						this.logger.debug('Built-in tools restricted', { tools: effectiveTools });
					}
				}

				// Allowed Tools is the SDK's auto-approve list — it pre-approves tools
				// rather than restricting the set. Under Ultracode, pre-approve what the
				// orchestration needs so it is not gated by a permission prompt.
				const effectiveAllowedTools =
					ultracode && allowedTools.length > 0
						? Array.from(new Set([...allowedTools, 'Workflow', 'Task']))
						: allowedTools;

				if (effectiveAllowedTools.length > 0) {
					queryOptions.options.allowedTools = effectiveAllowedTools;
					if (additionalOptions.debug) {
						this.logger.debug('Allowed tools configured', { allowedTools: effectiveAllowedTools });
					}
				}

				// Set disallowed tools if any are specified
				if (disallowedTools.length > 0) {
					queryOptions.options.disallowedTools = disallowedTools;
					if (additionalOptions.debug) {
						this.logger.debug('Disallowed tools configured', { disallowedTools });
					}
				}

				// Add fallback model if specified. The two dropdowns share most of their
				// values, and the SDK throws before spawning when they match — catch it
				// here so the message names the n8n field.
				if (additionalOptions.fallbackModel) {
					if (additionalOptions.fallbackModel === model) {
						throw new NodeOperationError(
							this.getNode(),
							'Fallback Model must be different from Model',
							{
								itemIndex,
								description:
									'The fallback is only used when the primary model is overloaded. Pick a different model, or set Fallback Model to None.',
							},
						);
					}
					queryOptions.options.fallbackModel = additionalOptions.fallbackModel;
				}

				// Map the Thinking selection to the SDK thinking config. When set, it
				// takes precedence over Max Thinking Tokens (SDK behavior).
				if (additionalOptions.thinking === 'disabled') {
					queryOptions.options.thinking = { type: 'disabled' };
				} else if (additionalOptions.thinking === 'adaptive') {
					queryOptions.options.thinking = { type: 'adaptive' };
				} else if (additionalOptions.thinking === 'summarized') {
					queryOptions.options.thinking = { type: 'adaptive', display: 'summarized' };
				}

				// Add max thinking tokens if specified
				if (additionalOptions.maxThinkingTokens && additionalOptions.maxThinkingTokens > 0) {
					queryOptions.options.maxThinkingTokens = additionalOptions.maxThinkingTokens;
				}

				// Hard spend cap. Max Turns and Timeout bound how long a run goes, not
				// what it costs; this is the only money bound the SDK offers.
				if (additionalOptions.maxBudgetUsd && additionalOptions.maxBudgetUsd > 0) {
					queryOptions.options.maxBudgetUsd = additionalOptions.maxBudgetUsd;
				}

				// Resume an explicit session when one is given. Otherwise fall back to
				// `continue`, which resolves "the most recent conversation in this
				// directory" — shared by every execution on the instance.
				if (operation === 'continue') {
					const sessionId = (this.getNodeParameter('sessionId', itemIndex, '') as string).trim();
					if (sessionId) {
						queryOptions.options.resume = sessionId;
					} else {
						queryOptions.options.continue = true;
					}
				}

				// Execute query
				const includeTranscript = additionalOptions.includeTranscript !== false;
				const startTime = Date.now();

				// Diagnostics — verifiable proof of what actually ran. Lets callers
				// confirm the resolved model, the effort Claude Code applied, and
				// whether Ultracode orchestration (Workflow/subagent tools) fired.
				// Built from whatever arrived, so it is also usable from the catch.
				const buildDiagnostics = (): Record<string, unknown> => {
					const systemInitMsg = messages.find(
						(m) => m.type === 'system' && (m as any).subtype === 'init',
					) as any;
					const resultMsg = messages.find((m) => m.type === 'result') as any;
					const countContent = (predicate: (c: any) => boolean): number =>
						messages
							.filter((m) => m.type === 'assistant')
							.reduce(
								(acc, m) => acc + ((m as any).message?.content || []).filter(predicate).length,
								0,
							);
					return {
						requestedModel: model,
						resolvedModel: systemInitMsg?.model ?? null,
						// Per-model spend, the only post-hoc record of which models ran.
						// The init message reports the model chosen at session start, so
						// it does not reflect a mid-run switch to the fallback.
						modelsUsed: Object.keys(resultMsg?.modelUsage ?? {}),
						fallbackModelRequested: additionalOptions.fallbackModel || null,
						requestedEffort: effort,
						effectiveEffort,
						appliedEffort: appliedEffort ?? null,
						permissionMode: queryOptions.options.permissionMode,
						sessionId: resultMsg?.session_id ?? systemInitMsg?.session_id ?? null,
						ultracodeRequested: ultracode,
						// Whether the CLI loaded the Workflow tool for this run. Allowed
						// Tools cannot gate this: it is the SDK's auto-approve list, not a
						// restriction. Disallowed Tools does remove tools from the model's
						// context, so the init list already accounts for it.
						workflowToolAvailable: (systemInitMsg?.tools ?? []).includes('Workflow'),
						workflowToolUses: countContent((c) => c.type === 'tool_use' && c.name === 'Workflow'),
						subagentToolUses: countContent((c) => c.type === 'tool_use' && c.name === 'Task'),
						thinkingRequested: additionalOptions.thinking || 'default',
						thinkingBlocks: countContent((c) => c.type === 'thinking'),
					};
				};

				// Held in a variable rather than iterated inline so control requests can reach it.
				const runningQuery = query(queryOptions);

				try {
					for await (const message of runningQuery) {
						messages.push(message);

						// In streaming input mode the session stays open while the input stream is
						// open, so the result message is the signal to close it. Without this the
						// query would never end.
						if (message.type === 'result') {
							promptStream.close();
						}

						if (additionalOptions.debug) {
							// Log detailed message content based on type
							if (message.type === 'system' && (message as any).subtype === 'init') {
								this.logger.debug('System init message', {
									type: message.type,
									subtype: (message as any).subtype,
									model: (message as any).model,
									toolCount: (message as any).tools?.length || 0,
								});
							} else if (message.type === 'assistant') {
								const content = (message as any).message?.content;
								this.logger.debug('Assistant message', {
									type: message.type,
									contentTypes: content?.map((c: any) => c.type) || [],
									textLength: content?.find((c: any) => c.type === 'text')?.text?.length || 0,
									hasToolUse: content?.some((c: any) => c.type === 'tool_use') || false,
								});
							} else if (message.type === 'user') {
								this.logger.debug('User message', {
									type: message.type,
									hasToolResult: !!(message as any).message?.content?.some(
										(c: any) => c.type === 'tool_result',
									),
								});
							} else if (message.type === 'result') {
								const resultMsg = message as any;
								this.logger.debug('Result message', {
									type: message.type,
									subtype: resultMsg.subtype,
									hasResult: !!resultMsg.result,
									hasError: !!resultMsg.errors?.length,
									resultLength: resultMsg.result ? String(resultMsg.result).length : 0,
									error: resultMsg.errors?.join('; ') || 'none',
									duration_ms: resultMsg.duration_ms,
									total_cost: resultMsg.total_cost_usd,
								});

								// Log more details for error_during_execution
								if (resultMsg.subtype === 'error_during_execution') {
									this.logger.error('Claude Code execution error', {
										subtype: resultMsg.subtype,
										error: resultMsg.errors?.join('; '),
										details: JSON.stringify(resultMsg).substring(0, 500),
									});
								}
							} else {
								this.logger.debug('Other message', {
									type: message.type,
									message: JSON.stringify(message).substring(0, 200),
								});
							}
						}

						// Track progress
						if (message.type === 'assistant' && message.message?.content) {
							const content = message.message.content[0];
							if (additionalOptions.debug) {
								if (content.type === 'text') {
									this.logger.debug('Assistant response', {
										text: content.text.substring(0, 100) + '...',
									});
								} else if (content.type === 'tool_use') {
									this.logger.debug('Tool use', { toolName: content.name });
								}
							}
						}
					}

					const duration = Date.now() - startTime;
					if (additionalOptions.debug) {
						this.logger.debug('Execution completed', {
							durationMs: duration,
							messageCount: messages.length,
						});

						// Log final messages array summary
						const messageTypes = messages.map((m) => ({
							type: m.type,
							subtype: (m as any).subtype,
						}));
						this.logger.debug('All messages in order', { messageTypes });
					}

					diagnostics = buildDiagnostics();
					if (additionalOptions.debug) {
						this.logger.debug('Run diagnostics', diagnostics);
					}

					// Format output based on selected format
					if (outputFormat === 'text') {
						// Find the result message
						const resultMessage = messages.find((m) => m.type === 'result') as any;

						if (additionalOptions.debug) {
							this.logger.debug('Processing text output format', {
								foundResultMessage: !!resultMessage,
								messageCount: messages.length,
							});
						}

						// Extract the final assistant message if no result message
						let finalText = '';
						let errorText = '';

						if (resultMessage) {
							// Subtype must be checked before the generic errors branch:
							// SDKResultError always carries a non-empty `errors` array, so a
							// generic-first order makes the recovery branches below dead code.
							if (resultMessage.result) {
								finalText = resultMessage.result;
							} else if (resultMessage.subtype === 'error_max_turns') {
								errorText = resultMessage.errors?.join('; ') || 'Maximum turns reached';
								// Try to get the last assistant message before max turns
								const assistantMessages = messages.filter(
									(m) => m.type === 'assistant' && m.message?.content,
								);
								if (assistantMessages.length > 0) {
									const lastMessage = assistantMessages[assistantMessages.length - 1] as any;
									const textContent = lastMessage.message?.content?.find(
										(c: any) => c.type === 'text',
									);
									if (textContent?.text) {
										finalText = `[PARTIAL - Max turns reached]\n\n${textContent.text}\n\n[Note: Task incomplete. Increase maxTurns parameter to complete.]`;
									} else {
										finalText =
											'Error: Maximum conversation turns reached. Consider increasing maxTurns parameter.';
									}
								} else {
									finalText =
										'Error: Maximum conversation turns reached. Consider increasing maxTurns parameter.';
								}
							} else if (resultMessage.subtype === 'error_during_execution') {
								errorText = resultMessage.errors?.join('; ') || 'Error during execution';
								// Try to get the last assistant message before the error
								const assistantMessages = messages.filter(
									(m) => m.type === 'assistant' && m.message?.content,
								);
								if (assistantMessages.length > 0) {
									const lastMessage = assistantMessages[assistantMessages.length - 1] as any;
									const textContent = lastMessage.message?.content?.find(
										(c: any) => c.type === 'text',
									);
									if (textContent?.text) {
										finalText = `[ERROR - Execution failed]\n\n${textContent.text}\n\n[Note: An error occurred during execution. Check logs for details.]`;
									} else {
										finalText = 'Error: Execution failed. Check debug logs for details.';
									}
								} else {
									finalText = 'Error: Execution failed. No output available.';
								}
							} else if (resultMessage.errors?.length) {
								// Remaining error subtypes (error_max_budget_usd,
								// error_max_structured_output_retries).
								errorText = resultMessage.errors.join('; ');
								finalText = `Error: ${errorText}`;
							}

							// Debug log the result message
							if (additionalOptions.debug) {
								this.logger.debug('Result message details', {
									type: resultMessage.type,
									subtype: resultMessage.subtype,
									hasResult: !!resultMessage.result,
									hasError: !!resultMessage.errors?.length,
									resultLength: resultMessage.result ? String(resultMessage.result).length : 0,
									errorMessage: resultMessage.errors?.join('; ') || 'none',
								});
							}
						} else {
							// Find the last assistant message with text content
							const assistantMessages = messages.filter(
								(m) => m.type === 'assistant' && m.message?.content,
							);
							if (assistantMessages.length > 0) {
								const lastMessage = assistantMessages[assistantMessages.length - 1] as any;
								const textContent = lastMessage.message?.content?.find(
									(c: any) => c.type === 'text',
								);
								finalText = textContent?.text || '';
							}

							if (!finalText) {
								finalText = 'No response generated - check debug logs for details';
							}
						}

						// Ensure all values are JSON-safe
						const outputData = {
							result: String(finalText || 'No response generated'),
							success: resultMessage?.subtype === 'success' ? true : false,
							duration_ms: Number(resultMessage?.duration_ms || 0),
							total_cost_usd: Number(resultMessage?.total_cost_usd || 0),
							diagnostics,
						};

						// Debug logging
						if (additionalOptions.debug) {
							this.logger.debug('Text output format data', {
								outputData,
								resultPreview:
									outputData.result.substring(0, 200) +
									(outputData.result.length > 200 ? '...' : ''),
								outputDataTypes: {
									result: typeof outputData.result,
									success: typeof outputData.success,
									duration_ms: typeof outputData.duration_ms,
									total_cost_usd: typeof outputData.total_cost_usd,
								},
							});

							// Log all message types for debugging
							const messageSummary = messages.reduce(
								(acc, msg) => {
									acc[msg.type] = (acc[msg.type] || 0) + 1;
									return acc;
								},
								{} as Record<string, number>,
							);

							this.logger.debug('Message summary', {
								messageSummary,
								totalMessages: messages.length,
								hasResultMessage: !!resultMessage,
								resultError: errorText || 'none',
							});

							try {
								JSON.stringify(outputData);
							} catch (e) {
								this.logger.error('Output data is not JSON-compatible', { error: e });
							}
						}

						returnData.push({
							json: outputData,
							pairedItem: { item: itemIndex },
						});
					} else if (outputFormat === 'messages') {
						// Return raw messages
						returnData.push({
							json: {
								...(includeTranscript ? { messages } : {}),
								messageCount: messages.length,
								diagnostics,
							},
							pairedItem: { item: itemIndex },
						});
					} else if (outputFormat === 'structured') {
						// Parse into structured format
						const userMessages = messages.filter((m) => m.type === 'user');
						const assistantMessages = messages.filter((m) => m.type === 'assistant');
						const toolUses = messages.filter(
							(m) =>
								m.type === 'assistant' && (m as any).message?.content?.[0]?.type === 'tool_use',
						);
						const systemInit = messages.find(
							(m) => m.type === 'system' && (m as any).subtype === 'init',
						) as any;
						const resultMessage = messages.find((m) => m.type === 'result') as any;

						returnData.push({
							json: {
								...(includeTranscript ? { messages } : {}),
								summary: {
									userMessageCount: userMessages.length,
									assistantMessageCount: assistantMessages.length,
									toolUseCount: toolUses.length,
									hasResult: !!resultMessage,
									toolsAvailable: systemInit?.tools || [],
								},
								result:
									resultMessage?.result ||
									(resultMessage?.errors?.length ? resultMessage.errors.join('; ') : null),
								metrics: resultMessage
									? {
											duration_ms: resultMessage.duration_ms,
											num_turns: resultMessage.num_turns,
											total_cost_usd: resultMessage.total_cost_usd,
											usage: resultMessage.usage,
											modelUsage: resultMessage.modelUsage,
										}
									: null,
								success: resultMessage?.subtype === 'success',
								diagnostics,
							},
							pairedItem: { item: itemIndex },
						});
					}
				} catch (queryError) {
					// The SDK delivers the result message before rejecting, so the spend
					// and session data are already in `messages` — report them instead of
					// claiming the run was free.
					const failedResult = messages.find((m) => m.type === 'result') as any;
					diagnostics = buildDiagnostics();

					// Only soften the failure when the workflow asked for it. Returning a
					// normal item unconditionally hid every failure behind a green
					// execution and bypassed n8n's error output.
					if (outputFormat === 'text' && this.continueOnFail()) {
						const errorMessage =
							queryError instanceof Error ? queryError.message : String(queryError);
						returnData.push({
							json: {
								result: `Error during execution: ${errorMessage}`,
								success: false,
								errorType: timedOut ? 'timeout' : 'execution_error',
								duration_ms: failedResult?.duration_ms ?? Date.now() - startTime,
								// null, not 0 — an unknown cost is not a free run
								total_cost_usd: failedResult?.total_cost_usd ?? null,
								num_turns: failedResult?.num_turns ?? null,
								session_id: failedResult?.session_id ?? null,
								usage: failedResult?.usage ?? null,
								diagnostics,
							},
							pairedItem: { item: itemIndex },
						});
					} else {
						throw queryError;
					}
				} finally {
					clearTimeout(timeoutId);
					// On an error path the loop stops consuming while the input generator is still
					// suspended waiting for a follow-up turn. Closing releases it.
					promptStream.close();
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
				// The SDK's AbortError does not override `name`, so it reports as 'Error'.
				// Track the timeout ourselves instead of sniffing the error.
				const isTimeout = timedOut;

				if (this.continueOnFail()) {
					const failedResult = messages.find((m) => m.type === 'result') as any;
					returnData.push({
						json: {
							error: errorMessage,
							errorType: isTimeout ? 'timeout' : 'execution_error',
							errorDetails: error instanceof Error ? error.stack : undefined,
							itemIndex,
							// A failed run still costs money — surface what it spent.
							total_cost_usd: failedResult?.total_cost_usd ?? null,
							num_turns: failedResult?.num_turns ?? null,
							session_id: failedResult?.session_id ?? null,
							usage: failedResult?.usage ?? null,
							diagnostics,
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				// Provide more specific error messages
				const userFriendlyMessage = isTimeout
					? `Operation timed out after ${timeout} seconds. Consider increasing the timeout in Additional Options.`
					: `Claude Code execution failed: ${errorMessage}`;

				throw new NodeOperationError(this.getNode(), userFriendlyMessage, {
					itemIndex,
					description: errorMessage,
				});
			}
		}

		return [returnData];
	}
}
