import type { Problem } from './problem';

/**
 * Which account a run authenticates as.
 *
 * Both nodes used to authenticate exactly one way: whatever the host process was logged in as. The
 * SDK spawns the CLI as a subprocess, and with no `env` option that subprocess inherits
 * `process.env` and then falls back to the host's `~/.claude/.credentials.json` — so every workflow
 * on an instance shared one identity, one spend and one set of plan limits.
 *
 * `Options.env` is the way out, but it REPLACES the subprocess environment wholesale rather than
 * merging into it (the SDK says so on the option itself). Everything in this module follows from
 * that one sentence: host mode must leave the option absent, and credential mode must hand over a
 * complete environment, not a patch.
 */
export type AuthMode = 'host' | 'apiKey' | 'oauthToken';

/** The credential type each mode reads. Host reads none. */
export const CREDENTIAL_FOR_MODE = {
	apiKey: 'claudeCodeApi',
	oauthToken: 'claudeCodeOAuthTokenApi',
} as const;

/**
 * Every variable the SDK treats as an authentication credential, copied from the `Tw` constant in
 * `@anthropic-ai/claude-agent-sdk@0.3.202`'s `sdk.mjs`.
 *
 * Setting the chosen one is not enough — the rest have to be cleared. An n8n container that exports
 * `ANTHROPIC_API_KEY` globally would otherwise keep authenticating on it inside a run the user
 * explicitly pointed at an OAuth credential, and the run would succeed, which is the worst shape
 * that failure could take.
 */
export const AUTH_ENV_VARS = [
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_TOKEN',
	'CLAUDE_CODE_OAUTH_TOKEN',
	'AWS_BEARER_TOKEN_BEDROCK',
	'ANTHROPIC_FOUNDRY_API_KEY',
	'ANTHROPIC_AWS_API_KEY',
	'ANTHROPIC_BEDROCK_MANTLE_API_KEY',
] as const;

/**
 * Which variable each mode sets. A table rather than a branch, for the same reason `APPLIERS` and
 * `MODELS` are tables: adding Bedrock or a gateway later is one entry here plus one option in the
 * selector.
 */
export const ENV_VAR_FOR_MODE = {
	apiKey: 'ANTHROPIC_API_KEY',
	oauthToken: 'CLAUDE_CODE_OAUTH_TOKEN',
} as const;

/** Host mode is the absence of an override, which is why it carries no secret. */
export type AuthSelection = { mode: 'host' } | { mode: 'apiKey' | 'oauthToken'; secret: string };

/** The environment to hand the CLI, or `undefined` to inherit the host's.
 *
 * `undefined` is not the same as a spread copy of `process.env`. Passing a copy would look
 * identical and behave identically today, but it would make the default path structurally
 * different from the one every existing workflow already runs on, for no gain. Absent means
 * untouched.
 *
 * `baseEnv` is a parameter so a test never has to read or mutate the real process environment.
 */
export function buildAuthEnv(
	selection: AuthSelection,
	baseEnv: NodeJS.ProcessEnv,
): Record<string, string | undefined> | undefined {
	if (selection.mode === 'host') return undefined;

	// Spread rather than build from scratch: the CLI needs PATH and HOME to spawn at all, and a
	// proxy variable dropped here is a container that silently loses its network.
	const env: Record<string, string | undefined> = { ...baseEnv };

	// `delete` rather than assigning undefined. A key present with an undefined value is a
	// different object shape, and the whole point of this loop is that the key is gone.
	for (const name of AUTH_ENV_VARS) delete env[name];

	env[ENV_VAR_FOR_MODE[selection.mode]] = selection.secret;
	return env;
}

/**
 * The failure when a credential is selected but carries nothing usable.
 *
 * It fails the item rather than falling back to the host: a workflow that named a credential and
 * silently ran on someone else's account is worse than one that stops.
 */
export function checkAuthSecret(mode: 'apiKey' | 'oauthToken', secret: string): Problem | null {
	if (secret.trim() !== '') return null;
	const field = mode === 'apiKey' ? 'API Key' : 'OAuth Token';
	return {
		message: `The selected credential has no ${field}`,
		description: `Open the credential and fill in ${field}, or set Authentication back to Host to use the account the n8n container is logged in as.`,
	};
}
