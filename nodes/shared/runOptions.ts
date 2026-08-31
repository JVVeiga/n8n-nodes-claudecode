import type { INodePropertyOptions, INodeProperties } from 'n8n-workflow';
import { FALLBACK_MODEL_OPTIONS } from '../ClaudeCode/description/models';
import { BUILT_IN_TOOL_OPTIONS } from '../ClaudeCode/description/toolOptions';

/**
 * The run options every sub-node offers, declared once.
 *
 * The Chat Model and the Task Tool each spelled these out — the six-entry Effort list and the
 * four-entry Thinking list verbatim in both files, 156 identical lines. `models.ts` and
 * `toolOptions.ts` exist precisely so the selectors "cannot drift apart"; the option ENTRIES
 * around them could, until now.
 *
 * Each export is a factory taking the wording that genuinely differs per node (a Chat Model
 * talks about "per Agent call", a tool about "per task run"), so the shape stays shared while
 * the prose stays honest.
 */

const EFFORT_VALUES: INodePropertyOptions[] = [
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
			'Standing dynamic multi-agent workflow orchestration on top of xHigh effort. Requires an xHigh-capable model.',
	},
];

const THINKING_VALUES: INodePropertyOptions[] = [
	{
		name: 'Default (Model/Effort Decides)',
		value: '',
		description: 'Let the model and effort level decide',
	},
	{ name: 'Adaptive', value: 'adaptive', description: 'Claude decides when and how much to think' },
	{
		name: 'Adaptive (Show Summary)',
		value: 'summarized',
		description: 'Adaptive thinking with a readable summary in the transcript',
	},
	{ name: 'Off', value: 'disabled', description: 'Disable extended thinking' },
];

export const effortOption = (description: string): INodeProperties => ({
	displayName: 'Effort',
	name: 'effort',
	type: 'options',
	// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
	// Ordered by depth, not alphabet — the list reads as a dial.
	options: EFFORT_VALUES,
	default: 'high',
	description,
});

export const thinkingOption = (): INodeProperties => ({
	displayName: 'Thinking',
	name: 'thinking',
	type: 'options',
	// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
	options: THINKING_VALUES,
	default: '',
	description: 'Control extended/adaptive thinking. Takes precedence over Max Thinking Tokens.',
});

export const fallbackModelOption = (): INodeProperties => ({
	displayName: 'Fallback Model',
	name: 'fallbackModel',
	type: 'options',
	// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
	// Same list as Model, plus None — see ../ClaudeCode/description/models.ts.
	options: FALLBACK_MODEL_OPTIONS,
	default: '',
	description: 'Automatically switch to fallback model when primary model is overloaded',
});

export const allowedToolsOption = (): INodeProperties => ({
	displayName: 'Allowed Tools',
	name: 'allowedTools',
	type: 'multiOptions',
	options: BUILT_IN_TOOL_OPTIONS,
	default: [],
	description:
		'Pre-approve these built-in tools so they run without a permission prompt. Does not restrict anything.',
});

export const disallowedToolsOption = (description: string): INodeProperties => ({
	displayName: 'Disallowed Tools',
	name: 'disallowedTools',
	type: 'multiOptions',
	options: BUILT_IN_TOOL_OPTIONS,
	default: [],
	description,
});

export const restrictToolsOption = (description: string): INodeProperties => ({
	displayName: 'Restrict Built-in Tools',
	name: 'restrictTools',
	type: 'multiOptions',
	options: BUILT_IN_TOOL_OPTIONS,
	default: [],
	description,
});

export const timeoutOption = (description: string): INodeProperties => ({
	displayName: 'Timeout',
	name: 'timeout',
	type: 'number',
	default: 300,
	description,
});

export const wrapUpGraceOption = (): INodeProperties => ({
	displayName: 'Timeout Wrap-Up Grace (Seconds)',
	name: 'wrapUpGraceSeconds',
	type: 'number',
	default: 60,
	typeOptions: { minValue: 0, maxValue: 600 },
	description:
		'Seconds reserved at the end of the Timeout for Claude to stop and report. Taken out of the Timeout, not added to it. Interrupting this way is what makes a stopped run report its real cost and session ID.',
});

export const maxTurnsOption = (description: string): INodeProperties => ({
	displayName: 'Max Turns',
	name: 'maxTurns',
	type: 'number',
	default: 25,
	description,
});

export const maxBudgetOption = (description: string): INodeProperties => ({
	displayName: 'Max Budget (USD)',
	name: 'maxBudgetUsd',
	type: 'number',
	default: 0,
	typeOptions: { minValue: 0, numberPrecision: 4 },
	description,
});

export const maxThinkingTokensOption = (): INodeProperties => ({
	displayName: 'Max Thinking Tokens',
	name: 'maxThinkingTokens',
	type: 'number',
	default: 0,
	description: 'Maximum number of thinking tokens (0 for unlimited)',
});

export const executablePathOption = (): INodeProperties => ({
	displayName: 'Claude Code Executable Path',
	name: 'pathToClaudeCodeExecutable',
	type: 'string',
	default: '',
	placeholder: '/usr/local/bin/claude',
	description:
		'Absolute path to a Claude Code CLI binary to use instead of the one bundled with the SDK. Leave empty to use the bundled executable.',
});

export const debugOption = (): INodeProperties => ({
	displayName: 'Debug Mode',
	name: 'debug',
	type: 'boolean',
	default: false,
	description: 'Whether to enable debug logging',
});

export const systemPromptOption = (
	description: string,
	displayOptions?: INodeProperties['displayOptions'],
): INodeProperties => ({
	displayName: 'System Prompt',
	name: 'systemPrompt',
	type: 'string',
	typeOptions: { rows: 4 },
	default: '',
	...(displayOptions ? { displayOptions } : {}),
	description,
});

/** The Model selector and Project Path, which sit outside the collection on every sub-node. */
export const projectPathProperty = (description: string): INodeProperties => ({
	displayName: 'Project Path',
	name: 'projectPath',
	type: 'string',
	default: '',
	placeholder: '/home/user/projects/my-app',
	description,
	hint: 'The path must exist inside the n8n container',
});
