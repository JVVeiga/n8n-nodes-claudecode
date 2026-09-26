import type { INodePropertyOptions, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionType } from 'n8n-workflow';
import { MODEL_OPTIONS } from '../ClaudeCode/description/models';
import { BUILT_IN_TOOL_OPTIONS } from '../ClaudeCode/description/toolOptions';
import { EFFORT_VALUES } from '../shared/runOptions';

export const INHERIT = 'inherit';

const MODEL_CHOICES: INodePropertyOptions[] = [
	{
		name: 'Inherit From Agent',
		value: INHERIT,
		description: 'Use the model the Claude Code Agent runs on',
	},
	...MODEL_OPTIONS,
];

const EFFORT_CHOICES: INodePropertyOptions[] = [
	{ name: 'Inherit From Agent', value: INHERIT },
	// Ultracode is a run mode, not a level an AgentDefinition accepts.
	...EFFORT_VALUES.filter((o) => o.value !== 'ultracode').map(({ name, value }) => ({
		name,
		value,
	})),
];

/** No credentials and no project path: a subagent runs inside the Agent's own session. */
export const claudeCodeSubagentDescription: INodeTypeDescription = {
	displayName: 'Claude Code Subagent',
	name: 'claudeCodeSubagent',
	icon: 'file:claudecodesubagent.svg',
	subtitle: '={{$parameter["agentName"] + " · " + $parameter["model"]}}',
	group: ['transform'],
	version: 1,
	description:
		'Define a specialist the Claude Code Agent can delegate to: its own instructions, model and tools, run in a separate context inside the Agent’s session',
	defaults: {
		name: 'Claude Code Subagent',
	},
	inputs: [],
	outputs: [{ type: NodeConnectionType.AiAgent }],
	outputNames: ['Subagent'],
	properties: [
		{
			displayName:
				'Connect this node to the Subagents input of a Claude Code Agent. It runs inside the Agent’s session, with the Agent’s authentication and project path; each delegation shows up on this node’s execution log.',
			name: 'subagentNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Name',
			name: 'agentName',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'e.g. code-reviewer',
			description:
				'Lowercase letters, digits and hyphens. Must be unique among the subagents of one Agent — the orchestrator uses it to delegate.',
		},
		{
			displayName: 'When to Use',
			name: 'whenToUse',
			type: 'string',
			required: true,
			typeOptions: { rows: 3 },
			default: '',
			placeholder: 'e.g. Reviews a diff for bugs and risky changes. Use after code is written.',
			description: 'What the orchestrator reads to decide when to delegate to this subagent',
		},
		{
			displayName: 'Instructions',
			name: 'instructions',
			type: 'string',
			required: true,
			typeOptions: { rows: 8 },
			default: '',
			description: 'The subagent’s system prompt',
		},
		{
			displayName: 'Model',
			name: 'model',
			type: 'options',
			// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
			// Inherit first, then the shared model list in its own order.
			options: MODEL_CHOICES,
			default: INHERIT,
			description: 'Claude model for this subagent',
		},
		{
			displayName: 'Options',
			name: 'options',
			type: 'collection',
			placeholder: 'Add Option',
			default: {},
			options: [
				{
					displayName: 'Additional Allowed Tool Names',
					name: 'extraTools',
					type: 'string',
					default: '',
					placeholder: 'e.g. mcp__n8n__search_docs',
					description:
						'Comma-separated tool names added to Allowed Tools — for example a tool connected to the Agent, which Claude Code knows as mcp__n8n__ followed by its name',
				},
				{
					displayName: 'Allowed Tools',
					name: 'tools',
					type: 'multiOptions',
					options: BUILT_IN_TOOL_OPTIONS,
					default: [],
					description:
						'Built-in tools this subagent may use. Leave empty (and Additional Allowed Tool Names empty) to inherit every tool the Agent has.',
				},
				{
					displayName: 'Disallowed Tools',
					name: 'disallowedTools',
					type: 'string',
					default: '',
					placeholder: 'e.g. Bash, Write',
					description: 'Comma-separated tool names this subagent is blocked from using',
				},
				{
					displayName: 'Effort',
					name: 'effort',
					type: 'options',
					// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
					// Ordered by depth, not alphabet — the list reads as a dial.
					options: EFFORT_CHOICES,
					default: INHERIT,
					description: 'Reasoning effort for this subagent',
				},
				{
					displayName: 'Max Turns',
					name: 'maxTurns',
					type: 'number',
					typeOptions: { minValue: 0 },
					default: 0,
					description: 'Maximum turns for one delegation. Set to 0 to inherit.',
				},
				{
					displayName: 'Skip Project CLAUDE.md',
					name: 'omitClaudeMd',
					type: 'boolean',
					default: false,
					description:
						'Whether to run without the user, project and local CLAUDE.md files, for a subagent that takes everything it needs from the delegation',
				},
			],
		},
	],
};
