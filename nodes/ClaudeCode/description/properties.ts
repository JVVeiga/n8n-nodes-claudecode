import type { INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionType } from 'n8n-workflow';
import { MODEL_OPTIONS } from './models';
import { BUILT_IN_TOOL_OPTIONS } from './toolOptions';
import { ADDITIONAL_OPTIONS } from './additionalOptions';

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
			displayName: 'Attach All Binaries',
			name: 'attachAllBinaries',
			type: 'boolean',
			// Defaults ON, unlike almost everything else here, because the common case is that a
			// file on the item is meant for Claude — a Monday screenshot, a CSV export. An item
			// with no binary data is unaffected: nothing is collected and nothing is sent.
			//
			// This does NOT change a stored workflow. n8n resolves a parameter with
			// `get(node.parameters, name, fallbackValue)`, so a node saved before this parameter
			// existed has no key and falls through to the fallback params.ts passes — which is
			// deliberately `false`. The schema default is what the editor writes into a NEWLY
			// added node. Do not "fix" that asymmetry: it is what keeps an upgrade inert.
			default: true,
			description:
				'Whether to send every binary property on the input item to Claude. Images, PDFs and small text files are attached directly to the request; anything larger or of a type that cannot be attached is written to a temporary directory Claude can read from. On by default because an item that carries a file usually carries it for a reason; turn it off to send nothing, or to name specific properties instead.',
		},
		{
			displayName: 'Binary Properties',
			name: 'binaryProperties',
			type: 'string',
			default: '',
			displayOptions: { show: { attachAllBinaries: [false] } },
			placeholder: 'data, screenshot, export',
			description:
				'Comma-separated binary property names on the input item to send to Claude. Leave empty for a text-only request. A name that is not on the item fails that item, naming the property — a run that silently answers without the evidence is worse than one that stops.',
			hint: 'Images, PDFs and small text files are attached directly; larger or unsupported types are staged to a temporary directory Claude reads from',
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
		ADDITIONAL_OPTIONS,
	],
};
