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
import { DEFAULT_VERIFIER_INSTRUCTIONS } from './verification/prompt';

// The Claude Code node needs `auto` to stay off for workflows built before 1.3. This node has no
// such history, so it offers On/Off with On as the default.
export const AGENT_ATTACH_ALL_PROPERTY: INodeProperties = {
	...ATTACH_ALL_BINARIES_PROPERTY,
	options: [
		{ name: 'Off', value: 'off', description: 'Send only the properties named below' },
		{ name: 'On', value: 'on', description: 'Send every binary property on the item' },
	],
	default: 'on',
	description:
		'Whether to send every binary property on the input item to Claude. Images, PDFs and small text files are attached directly to the request; anything larger or of a type that cannot be attached is written to a temporary directory Claude can read from. An item with no binary data is unaffected either way.',
};

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

export const VERIFICATION_OPTIONS: INodeProperties = {
	displayName: 'Verification',
	name: 'verification',
	type: 'collection',
	placeholder: 'Add Verification Setting',
	default: {},
	displayOptions: { hide: { outputMode: ['text'] } },
	description:
		'Check the items of the structured output before they leave the node. A second turn resumes the same session, tries to refute each item from the repository, and the node removes the ones it refutes. Needs Output Mode JSON Schema or Output Parser.',
	options: [
		{
			displayName: 'Enabled',
			name: 'enabled',
			type: 'boolean',
			default: false,
			description:
				'Whether to run the verification turn after a successful structured answer. It resumes the session of the first run, so it costs a second run and has its own full Timeout.',
		},
		{
			displayName: 'Equals Any Of',
			name: 'filterValues',
			type: 'string',
			default: '',
			placeholder: 'e.g. high, critical',
			description:
				'Comma-separated values of Only Items Where Field. Empty checks every item. Items that are not checked are always kept.',
		},
		{
			displayName: 'Items Path',
			name: 'itemsPath',
			type: 'string',
			default: '',
			placeholder: 'e.g. findings or review.inline_comments',
			description:
				'Required when enabled. Dot path to the array inside the structured output whose items are checked. An empty array skips the verification turn.',
		},
		{
			displayName: 'Only Items Where Field',
			name: 'filterField',
			type: 'string',
			default: '',
			placeholder: 'e.g. severity',
			description:
				'Check only the items whose value in this field is one of Equals Any Of. Leave empty to check every item.',
		},
		{
			displayName: 'Verifier Instructions',
			name: 'instructions',
			type: 'string',
			typeOptions: { rows: 4 },
			default: DEFAULT_VERIFIER_INSTRUCTIONS,
			description:
				'What the verification turn is told to do with the items. The items (as JSON, with their indices) and the answer format are added after it.',
		},
	],
};

export const claudeCodeAgentDescription: INodeTypeDescription = {
	displayName: 'Claude Code Agent',
	name: 'claudeCodeAgent',
	icon: 'file:claudecode.svg',
	group: ['transform'],
	version: 1,
	subtitle:
		'={{$parameter["model"] + ($parameter["outputMode"] === "jsonSchema" ? " · Schema" : $parameter["outputMode"] === "outputParser" ? " · Parser" : "") + ($parameter["verification"] && $parameter["verification"].enabled ? " · Verify" : "")}}',
	description:
		'Run Claude Code as an agent over each item, with n8n tools, Claude Code subagents and structured output',
	defaults: {
		name: 'Claude Code Agent',
	},
	// The editor spaces AI ports by count, not label length: the short label goes in the middle so
	// the long labels at the ends do not overlap.
	inputs: [
		NodeConnectionType.Main,
		{ type: NodeConnectionType.AiAgent, displayName: 'Subagents', required: false },
		{ type: NodeConnectionType.AiTool, displayName: 'Tools', required: false },
		{
			type: NodeConnectionType.AiOutputParser,
			displayName: 'Parser',
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
		AGENT_ATTACH_ALL_PROPERTY,
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
				'A session UUID from a previous run, or any stable key (a ticket, chat or user ID), hashed into a deterministic session ID. Sessions are stored in the ~/.claude directory of the n8n process, so a resume must run on the same machine (not on another queue-mode worker).',
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
		{
			displayName:
				'In Auto, Claude decides whether to delegate, so a connected subagent may never run. Choose Required to use every one; diagnostics.subagents shows which ran.',
			name: 'orchestrationNotice',
			type: 'notice',
			default: '',
			displayOptions: { show: { subagentOrchestration: ['auto'] } },
		},
		VERIFICATION_OPTIONS,
		AGENT_OPTIONS,
	],
};
