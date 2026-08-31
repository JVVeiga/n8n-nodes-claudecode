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
	processNameOption,
	projectPathProperty,
	reportUsageToOption,
	restrictToolsOption,
	systemPromptOption,
	thinkingOption,
	timeoutOption,
	wrapUpGraceOption,
} from '../shared/runOptions';

/**
 * The chat model's declarative schema. A sub-node: no main input, one `ai_languageModel` output,
 * which is the whole of how the editor decides it can plug into an AI Agent (spec F-13). The
 * parameters are the subset of the main node's that make sense per-model rather than per-item,
 * and they reuse the same option lists so the two nodes cannot drift.
 */
export const claudeCodeChatModelDescription: INodeTypeDescription = {
	displayName: 'Claude Code Chat Model',
	name: 'claudeCodeChatModel',
	icon: 'file:claudecode.svg',
	group: ['transform'],
	version: 1,
	description:
		'Use Claude Code as the chat model for an AI Agent — its own tools, MCP servers and CLAUDE.md included. Each Agent call runs a full Claude Code session, so it costs more and takes longer than a plain chat model.',
	defaults: {
		name: 'Claude Code Chat Model',
	},
	inputs: [],
	outputs: [{ type: NodeConnectionType.AiLanguageModel }],
	outputNames: ['Model'],
	credentials: AUTHENTICATION_CREDENTIALS,
	properties: [
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
				'Claude model to use. Aliases auto-resolve to the latest version; pinned IDs stay fixed.',
		},
		{
			displayName: 'Conversation Memory',
			name: 'memorySource',
			type: 'options',
			// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
			// Auto first: it is the default and the behaviour this node had before the selector
			// existed. Resolved in params.ts — a schema default cannot carry conditional meaning.
			options: [
				{
					name: 'Auto',
					value: 'auto',
					description:
						'Use a Claude Code session when Session ID is filled in, otherwise use the connected Memory sub-node',
				},
				{
					name: 'Claude Code Session',
					value: 'session',
					description:
						'Real multi-turn memory: the run resumes the Claude Code session named by Session ID, so prior turns and tool results come back. Any connected Memory sub-node is ignored.',
				},
				{
					name: 'N8n Memory Sub-Node',
					value: 'memory',
					description:
						'The connected Memory sub-node supplies the history, flattened into the prompt. Portable across containers and workers; the model reads the conversation rather than continuing it.',
				},
			],
			default: 'auto',
			description:
				'Where this model gets the conversation so far. Sessions live on this n8n container’s disk and carry tool results; a Memory sub-node stores messages wherever you point it and is re-sent as text on every call. Never both — that would put every prior turn in the context twice.',
		},
		{
			displayName: 'Session ID',
			name: 'sessionId',
			type: 'string',
			default: '',
			// Hidden in Memory mode, which is also what makes it INERT there: n8n strips a
			// parameter whose display condition is not met, so params.ts reads '' and the run is
			// stateless without anyone having to clear the field.
			//
			// Measured in the editor, and it is stronger than "ignored": switching to Memory and
			// letting n8n save DISCARDS the stored value — the parameter is gone from the
			// workflow, not merely unread. Switching back leaves the field empty, so the key has
			// to be typed again. Documented in the parameter description because a user who
			// toggles the selector to look around should not lose their expression silently.
			displayOptions: { show: { memorySource: ['auto', 'session'] } },
			placeholder: 'e.g. {{ $json.body.sessionId }}',
			description:
				'Give each conversation real multi-turn memory — prior turns and tool results included, no Memory node needed. Pass any STABLE key for the conversation (a Discord/WhatsApp/user ID, straight from the webhook): it is hashed into a deterministic session ID, created on the first message and resumed on every next one. Zero storage anywhere. A raw session UUID from a previous run also works. Sessions live on this n8n container’s disk, filed under the Project Path — keep that stable per conversation, and mount ~/.claude if conversations must survive a container rebuild. Note: switching Conversation Memory to the Memory sub-node clears this field when the workflow saves.',
		},
		projectPathProperty(
			'The directory Claude Code runs in. Its CLAUDE.md, MCP servers and settings load from here — this is what makes the model more than a bare LLM. If empty, uses the current working directory.',
		),
		{
			displayName:
				'The tools connected to the AI Agent are handed to Claude Code and run inside its session. The Agent therefore sees a single model turn; tool activity shows up on each tool’s own execution log. Human-in-the-loop tool approval and Return Intermediate Steps are not supported.',
			name: 'toolExecutionNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Options',
			name: 'options',
			type: 'collection',
			placeholder: 'Add Option',
			default: {},
			// eslint-disable-next-line n8n-nodes-base/node-param-collection-type-unsorted-items
			// Composed from shared/runOptions.ts — see the note in the Task Tool's description.
			options: [
				allowedToolsOption(),
				executablePathOption(),
				debugOption(),
				disallowedToolsOption(
					'Built-in tools Claude Code is blocked from using. Takes precedence over Allowed Tools.',
				),
				effortOption(
					'Reasoning effort — controls how much thinking Claude applies. Silently downgraded on models that don’t support the selected level.',
				),
				fallbackModelOption(),
				maxBudgetOption(
					'Hard spend cap for a single Agent call. The run stops once it is exceeded. Set to 0 to disable.',
				),
				maxThinkingTokensOption(),
				processNameOption(),
				reportUsageToOption(),
				maxTurnsOption(
					'Maximum number of internal Claude Code turns per Agent call. Tool-heavy requests need more.',
				),
				restrictToolsOption(
					'Limit Claude Code to this base set of built-in tools — everything else is never loaded. Leave empty for the full set. Tools connected to the AI Agent are always added on top, so a restriction cannot unplug them.',
				),
				{
					displayName: 'System Prompt Mode',
					name: 'systemPromptMode',
					type: 'options',
					// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
					options: [
						{
							name: 'Append to Claude Code Preset',
							value: 'append',
							description:
								'The Agent’s system message is appended to Claude Code’s own system prompt. Keeps its agent and tool behaviour intact — recommended.',
						},
						{
							name: 'Replace Claude Code Preset',
							value: 'replace',
							description:
								'The Agent’s system message becomes the entire system prompt. Closer to a plain chat model; Claude Code’s own tooling behaviour degrades.',
						},
					],
					default: 'append',
					description: 'What to do with the system message the AI Agent supplies',
				},
				systemPromptOption(
					'Additional standing instructions from this node, appended alongside the Agent’s system message',
					{ show: { systemPromptMode: ['append'] } },
				),
				thinkingOption(),
				timeoutOption(
					'Maximum seconds per Agent call before the run is stopped. A timed-out call fails the Agent node.',
				),
				wrapUpGraceOption(),
			],
		},
	],
};
