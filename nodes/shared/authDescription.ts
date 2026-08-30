import type { INodeCredentialDescription, INodeProperties } from 'n8n-workflow';

/**
 * The Authentication selector and its credentials, shared by both nodes.
 *
 * **The parameter is named `authSource`, not `authentication`, and that is load-bearing.** n8n
 * reserves the name `authentication`: the editor never renders it as an ordinary parameter, it
 * absorbs it into the credentials UI and builds the dropdown from `credentials[]` — one option per
 * credential type. `host` maps to no credential, so there was nothing for n8n to draw and it drew
 * nothing at all: the selector was invisible and a user could never leave Host from the editor.
 *
 * Every unit test and all three E2E cases passed anyway, because each of them sets the parameter in
 * workflow JSON and none of them goes through the editor. Found by driving the real UI in a
 * browser. The displayName stays "Authentication" — only the internal name moved.
 *
 * They are one declaration rather than two copies for the same reason `projectPath.ts` exists: the
 * two nodes carried byte-identical Project Path checks and they drifted. A selector whose options
 * differ between the nodes would be worse — the same workflow would authenticate one way for a run
 * and another way for the usage read on the same account.
 */

export const AUTHENTICATION_PROPERTY: INodeProperties = {
	displayName: 'Authentication',
	name: 'authSource',
	type: 'options',
	noDataExpression: true,
	// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
	// Host first, deliberately: it is the default and the behaviour every workflow saved before
	// this parameter existed already has. Alphabetical order would put API Key at the top and
	// invite people to change something that was working.
	options: [
		{
			name: 'Host',
			value: 'host',
			description:
				'Use whatever account the n8n container itself is logged in as. This is what every run did before credentials existed.',
		},
		{
			name: 'API Key',
			value: 'apiKey',
			description:
				'Run this execution on an Anthropic API key, billed as API usage. Overrides the host login for this execution only.',
		},
		{
			name: 'OAuth Token',
			value: 'oauthToken',
			description:
				"Run this execution on a Claude Code OAuth token, billed against that account's Claude plan. Overrides the host login for this execution only.",
		},
	],
	default: 'host',
};

export const AUTHENTICATION_CREDENTIALS: INodeCredentialDescription[] = [
	{
		name: 'claudeCodeApi',
		// Required only in this mode — that is what makes Host need no credential at all.
		required: true,
		displayOptions: { show: { authSource: ['apiKey'] } },
	},
	{
		name: 'claudeCodeOAuthTokenApi',
		required: true,
		displayOptions: { show: { authSource: ['oauthToken'] } },
	},
];
