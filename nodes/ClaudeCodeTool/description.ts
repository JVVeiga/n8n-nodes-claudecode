import type { INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionType } from 'n8n-workflow';
import { MODEL_OPTIONS } from '../ClaudeCode/description/models';
import { AUTHENTICATION_CREDENTIALS, AUTHENTICATION_PROPERTY } from '../shared/authDescription';
import {
	allowedToolsOption,
	debugOption,
	disallowedToolsOption,
	effortOption,
	executablePathOption,
	fallbackModelOption,
	maxBudgetOption,
	maxThinkingTokensOption,
	maxTurnsOption,
	projectPathProperty,
	restrictToolsOption,
	systemPromptOption,
	thinkingOption,
	timeoutOption,
	wrapUpGraceOption,
} from '../shared/runOptions';

/**
 * A purpose-built `ai_tool` sub-node — NOT the auto-generated `claudeCodeTool` wrapper, which
 * exposes every node parameter and offers the Agent a zero-argument schema unless the author
 * hand-writes $fromAI expressions (CONCERNS d2). Here the contract is fixed: one `task` string
 * in, the result text out, and only the knobs that make sense per tool.
 *
 * The internal name avoids `claudeCodeTool`, the name n8n USED to synthesize from the main
 * node's `usableAsTool`. That flag is gone, so the synthesized type is gone with it: a stored
 * workflow holding one loads as an unrecognized node and must be re-wired to this one.
 */
export const claudeCodeToolDescription: INodeTypeDescription = {
	displayName: 'Claude Code Task Tool',
	name: 'claudeCodeTaskTool',
	icon: 'file:claudecode.svg',
	group: ['transform'],
	version: 1,
	description:
		'Give an AI Agent a full coding agent as a tool: Claude Code runs one task per call — reading files, running commands, writing code in its project directory — and returns the result as text. Works with any Chat Model on the Agent.',
	defaults: {
		name: 'Claude Code Task Tool',
	},
	inputs: [],
	outputs: [{ type: NodeConnectionType.AiTool }],
	outputNames: ['Tool'],
	credentials: AUTHENTICATION_CREDENTIALS,
	properties: [
		{
			displayName: 'Tool Description',
			name: 'toolDescription',
			type: 'string',
			typeOptions: { rows: 3 },
			default:
				'Runs a coding or file task with Claude Code, a full coding agent that can read files, run commands and write code in its project directory. Input: one clear task in natural language. Returns the result as text.',
			description:
				'What the Agent reads to decide when and how to use this tool. Describe what the project contains and what kinds of tasks it should send here.',
		},
		AUTHENTICATION_PROPERTY,
		{
			displayName: 'Model',
			name: 'model',
			type: 'options',
			// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
			// Aliases first, then pinned IDs newest-first — see ../ClaudeCode/description/models.ts.
			options: MODEL_OPTIONS,
			default: 'sonnet',
			description:
				'Claude model for the task runs. Aliases auto-resolve to the latest version; pinned IDs stay fixed.',
		},
		projectPathProperty(
			'The directory the tasks run in. Its CLAUDE.md, MCP servers and settings load from here. If empty, uses the current working directory.',
		),
		{
			displayName: 'Options',
			name: 'options',
			type: 'collection',
			placeholder: 'Add Option',
			default: {},
			// eslint-disable-next-line n8n-nodes-base/node-param-collection-type-unsorted-items
			// Composed from shared/runOptions.ts — the entries themselves are identical across the
			// sub-nodes and were duplicated line for line once already.
			options: [
				allowedToolsOption(),
				executablePathOption(),
				debugOption(),
				disallowedToolsOption(
					'Built-in tools Claude Code is blocked from using in task runs. Takes precedence over Allowed Tools.',
				),
				effortOption(
					'Reasoning effort for task runs. Silently downgraded on models that don’t support the selected level.',
				),
				fallbackModelOption(),
				maxBudgetOption(
					'Hard spend cap per task run. The run stops once it is exceeded. Set to 0 to disable.',
				),
				maxThinkingTokensOption(),
				maxTurnsOption('Maximum internal Claude Code turns per task run'),
				restrictToolsOption(
					'Limit Claude Code to this base set of built-in tools during task runs — everything else is never loaded. Leave empty for the full set.',
				),
				systemPromptOption(
					'Standing instructions for every task run, appended to Claude Code’s own system prompt',
				),
				thinkingOption(),
				timeoutOption(
					'Maximum seconds per task run. A timed-out task returns a timeout message (with any partial result) to the Agent as text.',
				),
				wrapUpGraceOption(),
			],
		},
	],
};
