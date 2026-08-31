import type { INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionType } from 'n8n-workflow';
import { AUTHENTICATION_CREDENTIALS, AUTHENTICATION_PROPERTY } from '../shared/authDescription';
import { projectPathProperty } from '../shared/runOptions';

/**
 * The Usage read as a purpose-built `ai_tool` sub-node. The internal name avoids
 * `claudeCodeUsageTool`, the name n8n USED to synthesize from the Usage node's `usableAsTool`.
 * That flag is gone, so the synthesized type is gone with it — a stored workflow holding one
 * loads as an unrecognized node and must be re-wired to this one.
 *
 * **No usage reporting here, deliberately.** The Chat Model and the Task Tool offer it because
 * they run a Claude Code session and therefore have a session id, turns, tokens and a cost to
 * report. This tool runs a usage READ: there is no session and no inference, so a row from it
 * would be a line of zeros in a table of runs. The only money it can spend is the opt-in probe,
 * and one field is not a reason to file a run that never happened.
 */
export const claudeCodeUsageToolDescription: INodeTypeDescription = {
	displayName: 'Claude Code Usage Tool',
	name: 'claudeCodePlanUsageTool',
	icon: 'file:claudecodeusage.svg',
	group: ['transform'],
	version: 1,
	description:
		'Give an AI Agent a zero-argument tool that reads the Claude account’s plan usage: utilisation and reset time per window, as JSON text',
	defaults: {
		name: 'Claude Code Usage Tool',
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
				'Reads the current Claude plan usage: percentage used and reset time for each rate-limit window (5-hour, 7-day, …). Takes no input. Returns a JSON report.',
			description: 'What the Agent reads to decide when to call this tool',
		},
		AUTHENTICATION_PROPERTY,
		projectPathProperty(
			'The directory the read runs in. Claude Code resolves settings and hooks per directory, so a project with a slow SessionStart hook is worth pointing away from. If empty, uses the current working directory.',
		),
		{
			displayName: 'Options',
			name: 'options',
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
						'Absolute path to a Claude Code CLI binary to use instead of the one bundled with the SDK',
				},
				{
					displayName: 'Debug Mode',
					name: 'debug',
					type: 'boolean',
					default: false,
					description: 'Whether to enable debug logging',
				},
				{
					displayName: 'Declare Profile Scope on Retry',
					name: 'declareProfileScope',
					type: 'boolean',
					default: true,
					description:
						'Whether to retry the read declaring the user:profile scope when a token session reports no plan windows. Free — the token still only has whatever the server issued it.',
				},
				{
					displayName: 'Include Account Email',
					name: 'includeAccountEmail',
					type: 'boolean',
					default: false,
					description:
						'Whether the report hands the account email to the Agent. Off by default — the model does not usually need it.',
				},
				{
					displayName: 'Probe With a Minimal Prompt If Unavailable',
					name: 'probeIfUnavailable',
					type: 'boolean',
					default: false,
					description:
						'Whether to send one trivial paid turn (~$0.001) so the rate-limit response headers seed the 5-hour and 7-day windows when the usage endpoint refuses the credential — the only route for an inference-only token from `claude setup-token`',
				},
				{
					displayName: 'Timeout (Seconds)',
					name: 'timeout',
					type: 'number',
					default: 60,
					typeOptions: { minValue: 5 },
					description: 'Maximum seconds for the whole read before it fails',
				},
			],
		},
	],
};
