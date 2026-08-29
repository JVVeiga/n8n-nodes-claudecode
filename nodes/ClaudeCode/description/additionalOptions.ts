import type { INodeProperties } from 'n8n-workflow';
import { EXTENSION_OPTIONS } from './extensionOptions';
import { FALLBACK_MODEL_OPTIONS } from './models';

/**
 * The Additional Options collection: everything that is not part of the everyday shape of a
 * request. Split from properties.ts because it is half the schema by line count and a separate
 * concern — these are the knobs you reach for when the default is wrong, not the ones you set
 * on every node.
 */
export const ADDITIONAL_OPTIONS: INodeProperties = {
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
			displayName: 'Output Envelope',
			name: 'outputEnvelope',
			type: 'options',
			// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
			options: [
				{
					name: 'Auto (Match Node Version)',
					value: 'auto',
					description:
						'Node versions 1 and 1.1 emit their original per-format shapes; 1.2 emits the unified envelope',
				},
				{
					name: 'Unified (1.2 Shape)',
					value: 'unified',
					description:
						'Emit the unified envelope regardless of node version — how an existing node opts in without being recreated',
				},
			],
			default: 'auto',
			description:
				'Which output shape this node emits. A node keeps the typeVersion it was created with, and n8n offers no UI to change it — so an older node cannot otherwise reach the unified shape except by being deleted and re-added, which loses its configuration. Set this to Unified to opt in in place. Auto changes nothing.',
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
			displayName: 'Allowed Extensions',
			name: 'allowedExtensions',
			type: 'multiOptions',
			// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
			// Sorted by extension in description/extensionOptions.ts.
			options: EXTENSION_OPTIONS,
			default: [],
			description:
				'Only send binary properties whose file extension is selected here. Anything else on the item is skipped and the run continues without it — this filters what is considered, it does not reject a request, so nothing fails because of it. Leave empty to consider every file. What was skipped is reported under diagnostics.attachments.skipped.',
		},
		{
			displayName: 'Inline Text Size Limit (KB)',
			name: 'inlineTextLimitKb',
			type: 'number',
			default: 256,
			typeOptions: { minValue: 0 },
			description:
				'How large a text file (CSV, HTML, JSON, Markdown, plain text) may be before it is written to a temporary directory instead of being attached to the request. An attached file is in the context on every turn, so 256 KB is roughly 64k tokens per turn; a staged file costs nothing until Claude reads it, but Claude has to choose to read it. Set to 0 to stage every text file. Image and PDF ceilings are fixed by the API and are not configurable.',
		},
		{
			displayName: 'Max Attachment Size (MB)',
			name: 'maxAttachmentMb',
			type: 'number',
			default: 50,
			typeOptions: { minValue: 1 },
			description:
				'Hard per-file cap. A binary property larger than this fails the item rather than being attached or staged. This is a guard against an unbounded upstream node, not a routing decision.',
		},
		{
			displayName: 'Max Attachment Count',
			name: 'maxAttachmentCount',
			type: 'number',
			default: 16,
			typeOptions: { minValue: 1 },
			description:
				'Maximum number of binary properties to send from one item. More than this fails the item. Mainly relevant with Attach All Binaries, where the count comes from upstream rather than from you.',
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
};
