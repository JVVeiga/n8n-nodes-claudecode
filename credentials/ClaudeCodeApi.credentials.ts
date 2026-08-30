import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * An Anthropic API key, used for one execution only.
 *
 * Selected on the node, it becomes `ANTHROPIC_API_KEY` in the environment of the Claude Code CLI
 * subprocess that execution spawns — and nowhere else. It never touches the host's
 * `~/.claude/.credentials.json`, so two workflows running side by side on the same n8n instance can
 * bill two different accounts.
 */
export class ClaudeCodeApi implements ICredentialType {
	name = 'claudeCodeApi';

	displayName = 'Claude Code API';

	documentationUrl = 'https://docs.anthropic.com/en/api/overview';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'An Anthropic API key from console.anthropic.com. Billed as API usage, not against a Claude plan — the Claude Code Usage node reports no plan limits for it.',
		},
	];

	// Used by the Test button only. The node itself never makes an HTTP request: it hands the key
	// to the CLI through the subprocess environment.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'x-api-key': '={{$credentials.apiKey}}',
				'anthropic-version': '2023-06-01',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.anthropic.com',
			url: '/v1/models',
			method: 'GET',
		},
	};
}
