import type { INodeProperties, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionType } from 'n8n-workflow';
import { PERMISSION_MODE_OPTION } from '../ClaudeCode/description/additionalOptions';
import {
	ATTACH_ALL_BINARIES_PROPERTY,
	BINARY_PROPERTIES_PROPERTY,
} from '../ClaudeCode/description/properties';
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
	modelProperty,
	processNameOption,
	projectPathProperty,
	reportUsageToOption,
	restrictToolsOption,
	systemPromptOption,
	thinkingOption,
	timeoutOption,
	wrapUpGraceOption,
} from '../shared/runOptions';

const JSON_SCHEMA_EXAMPLE = JSON.stringify(
	{
		type: 'object',
		properties: {
			summary: { type: 'string', description: 'One-paragraph answer' },
			findings: { type: 'array', items: { type: 'string' } },
		},
		required: ['summary', 'findings'],
	},
	null,
	2,
);

export const AGENT_OPTIONS: INodeProperties = {
	displayName: 'Options',
	name: 'options',
	type: 'collection',
	placeholder: 'Add Option',
	default: {},
	options: [
		{
			displayName: 'Allow Claude.ai Connectors',
			name: 'allowClaudeAiConnectors',
			type: 'boolean',
			default: false,
			description:
				'Whether to let a full claude.ai login connect its cloud connectors (Gmail, Drive, …) into the run. Off by default: otherwise every run carries those tools, and their schemas cost tokens on every turn. MCP servers configured in the project are unaffected.',
		},
		allowedToolsOption(),
		executablePathOption(),
		debugOption(),
		disallowedToolsOption(
			'Built-in tools Claude Code is blocked from using. Takes precedence over Allowed Tools.',
		),
		fallbackModelOption(),
		{
			displayName: 'Include Transcript',
			name: 'includeTranscript',
			type: 'boolean',
			default: false,
			description:
				'Whether to add the full message transcript to the output as `messages`. It carries every tool result verbatim — file contents, command output — and n8n stores it with the execution.',
		},
		maxBudgetOption(
			'Hard spend cap for one item’s run. The run stops once it is exceeded. Set to 0 to disable.',
		),
		maxThinkingTokensOption(),
		PERMISSION_MODE_OPTION,
		processNameOption(),
		reportUsageToOption(),
		restrictToolsOption(
			'Limit Claude Code to this base set of built-in tools — everything else is never loaded. Leave empty for the full set. Connected tools are always added on top, so a restriction cannot unplug them.',
		),
		systemPromptOption(
			'Standing instructions appended to Claude Code’s own system prompt. Instruction Files are appended after it.',
		),
		thinkingOption(),
		wrapUpGraceOption(),
	],
};

export const claudeCodeAgentDescription: INodeTypeDescription = {
	displayName: 'Claude Code Agent',
	name: 'claudeCodeAgent',
	icon: 'file:claudecode.svg',
	group: ['transform'],
	version: 1,
	subtitle: '={{$parameter["outputMode"]}}',
	description:
		'Run Claude Code as an agent over each item, with n8n tools, Claude Code subagents and structured output',
	defaults: {
		name: 'Claude Code Agent',
	},
	inputs: [
		NodeConnectionType.Main,
		{ type: NodeConnectionType.AiTool, displayName: 'Tools', required: false },
		{ type: NodeConnectionType.AiAgent, displayName: 'Subagents', required: false },
		{
			type: NodeConnectionType.AiOutputParser,
			displayName: 'Output Parser',
			maxConnections: 1,
			required: false,
		},
	],
	outputs: [NodeConnectionType.Main],
	credentials: AUTHENTICATION_CREDENTIALS,
	properties: [
		AUTHENTICATION_PROPERTY,
		{
			displayName: 'Prompt',
			name: 'prompt',
			type: 'string',
			typeOptions: { rows: 4 },
			default: '',
			required: true,
			description: 'The task for Claude Code',
			placeholder: 'e.g. Review the changes on this branch and list the risky ones',
			hint: 'Use expressions like {{$json.prompt}} to use data from previous nodes',
		},
		projectPathProperty(
			'The directory Claude Code runs in. Its CLAUDE.md, MCP servers and settings load from here, and Instruction Files are read relative to it. If empty, uses the current working directory.',
		),
		modelProperty(),
		effortOption(
			'Reasoning effort — controls how much thinking Claude applies. Ultracode adds standing dynamic-workflow orchestration on top of xHigh. Silently downgraded on models that don’t support the selected level.',
		),
		maxTurnsOption(
			'Maximum number of conversation turns for one item. Subagent turns do not count against it.',
		),
		timeoutOption(
			'Maximum time in seconds for one item, before the run is stopped. A resumed session that has to be created shares this budget.',
		),
		ATTACH_ALL_BINARIES_PROPERTY,
		BINARY_PROPERTIES_PROPERTY,
		{
			displayName: 'Output Mode',
			name: 'outputMode',
			type: 'options',
			noDataExpression: true,
			options: [
				{
					name: 'JSON Schema',
					value: 'jsonSchema',
					description: 'Return an object validated against the JSON Schema below',
				},
				{
					name: 'Output Parser',
					value: 'outputParser',
					description: 'Return an object validated against the connected output parser’s schema',
				},
				{
					name: 'Text',
					value: 'text',
					description: 'Return the final answer as text',
				},
			],
			default: 'text',
			description:
				'Whether the run must end in a structured object. The object is emitted as `structured`; `result` keeps the text. A run that ends without a valid object fails the item.',
		},
		{
			displayName: 'JSON Schema',
			name: 'jsonSchema',
			type: 'json',
			default: JSON_SCHEMA_EXAMPLE,
			displayOptions: { show: { outputMode: ['jsonSchema'] } },
			description: 'A JSON Schema whose top level is an object ("type": "object")',
		},
		{
			displayName: 'Instruction Files',
			name: 'instructionFiles',
			type: 'string',
			typeOptions: { rows: 3 },
			default: '',
			placeholder: '.review/rules.md\ndocs/conventions.md',
			description:
				'Files appended to the system prompt, one path per line, relative to Project Path. A file that does not exist is skipped and listed in diagnostics.instructions.missing. CLAUDE.md already loads on its own.',
		},
		{
			displayName: 'Session',
			name: 'sessionMode',
			type: 'options',
			options: [
				{
					name: 'New',
					value: 'new',
					description: 'Every item runs in a fresh session',
				},
				{
					name: 'Resume',
					value: 'resume',
					description: 'Continue the session named by Session ID or Key, creating it on first use',
				},
			],
			default: 'new',
			description: 'Whether each run starts fresh or continues a conversation',
		},
		{
			displayName: 'Session ID or Key',
			name: 'sessionKey',
			type: 'string',
			default: '',
			displayOptions: { show: { sessionMode: ['resume'] } },
			placeholder: 'e.g. {{ $json.ticketId }}',
			description:
				'A session UUID from a previous run, or any stable key (a ticket, chat or user ID), hashed into a deterministic session ID. Sessions live on this n8n container’s disk under the Project Path.',
		},
		{
			displayName: 'Subagent Orchestration',
			name: 'subagentOrchestration',
			type: 'options',
			options: [
				{
					name: 'Auto',
					value: 'auto',
					description: 'Claude decides which connected subagents to use',
				},
				{
					name: 'Required',
					value: 'required',
					description:
						'Ask Claude to delegate to every connected subagent. diagnostics.subagents shows any that did not run.',
				},
			],
			default: 'auto',
			description: 'How the connected subagents are used',
		},
		AGENT_OPTIONS,
	],
};
