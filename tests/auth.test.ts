import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	AUTH_ENV_VARS,
	buildAuthEnv,
	checkAuthSecret,
	CREDENTIAL_FOR_MODE,
	ENV_VAR_FOR_MODE,
} from '../nodes/shared/auth';

/** A base environment carrying every auth variable, so a scrub that misses one is visible. */
const pollutedEnv = (): NodeJS.ProcessEnv => ({
	PATH: '/usr/bin',
	HOME: '/home/node',
	HTTPS_PROXY: 'http://proxy:8080',
	ANTHROPIC_API_KEY: 'host-api-key',
	ANTHROPIC_AUTH_TOKEN: 'host-auth-token',
	CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth-token',
	AWS_BEARER_TOKEN_BEDROCK: 'host-bedrock',
	ANTHROPIC_FOUNDRY_API_KEY: 'host-foundry',
	ANTHROPIC_AWS_API_KEY: 'host-aws',
	ANTHROPIC_BEDROCK_MANTLE_API_KEY: 'host-mantle',
});

const has = (env: object, key: string) => Object.prototype.hasOwnProperty.call(env, key);

describe('AUTH_ENV_VARS', () => {
	// Pinned deliberately. This list is copied out of the SDK's own `Tw` constant, and a variable
	// the SDK added since is one this node would leave leaking through from the host — a silent
	// wrong-account run rather than a visible failure. A dependency bump that moves the list should
	// break this test and make someone look.
	it('is the SDK 0.3.202 auth variable set, exactly', () => {
		assert.deepEqual(
			[...AUTH_ENV_VARS],
			[
				'ANTHROPIC_API_KEY',
				'ANTHROPIC_AUTH_TOKEN',
				'CLAUDE_CODE_OAUTH_TOKEN',
				'AWS_BEARER_TOKEN_BEDROCK',
				'ANTHROPIC_FOUNDRY_API_KEY',
				'ANTHROPIC_AWS_API_KEY',
				'ANTHROPIC_BEDROCK_MANTLE_API_KEY',
			],
		);
	});

	it('contains every variable the modes can set', () => {
		for (const name of Object.values(ENV_VAR_FOR_MODE)) {
			assert.ok(AUTH_ENV_VARS.includes(name), `${name} must be scrubbed before it is set`);
		}
	});
});

describe('CREDENTIAL_FOR_MODE', () => {
	it('names the two credential types', () => {
		assert.deepEqual(CREDENTIAL_FOR_MODE, {
			apiKey: 'claudeCodeApi',
			oauthToken: 'claudeCodeOAuthTokenApi',
		});
	});
});

describe('buildAuthEnv', () => {
	it('returns undefined for host, so the SDK option is left absent entirely', () => {
		assert.equal(buildAuthEnv({ mode: 'host' }, pollutedEnv()), undefined);
	});

	it('sets ANTHROPIC_API_KEY for apiKey', () => {
		const env = buildAuthEnv({ mode: 'apiKey', secret: 'sk-ant-mine' }, pollutedEnv());
		assert.equal(env?.ANTHROPIC_API_KEY, 'sk-ant-mine');
	});

	it('sets CLAUDE_CODE_OAUTH_TOKEN for oauthToken', () => {
		const env = buildAuthEnv({ mode: 'oauthToken', secret: 'sk-ant-oat01-mine' }, pollutedEnv());
		assert.equal(env?.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-mine');
	});

	it('removes the other six auth variables rather than blanking them', () => {
		const env = buildAuthEnv({ mode: 'oauthToken', secret: 'mine' }, pollutedEnv());
		assert.ok(env);
		for (const name of AUTH_ENV_VARS) {
			if (name === 'CLAUDE_CODE_OAUTH_TOKEN') continue;
			assert.equal(has(env, name), false, `${name} is still an own property`);
		}
	});

	// The scenario the whole feature exists for: a container with a global key, and a workflow
	// pointed at a different account. If the host key survived, the run would succeed on the wrong
	// credential and nothing would say so.
	it('does not let a host ANTHROPIC_API_KEY survive an oauthToken run', () => {
		const env = buildAuthEnv({ mode: 'oauthToken', secret: 'mine' }, pollutedEnv());
		assert.equal(has(env as object, 'ANTHROPIC_API_KEY'), false);
	});

	it('does not let a host CLAUDE_CODE_OAUTH_TOKEN survive an apiKey run', () => {
		const env = buildAuthEnv({ mode: 'apiKey', secret: 'mine' }, pollutedEnv());
		assert.equal(has(env as object, 'CLAUDE_CODE_OAUTH_TOKEN'), false);
	});

	it('keeps everything that is not authentication', () => {
		const env = buildAuthEnv({ mode: 'apiKey', secret: 'mine' }, pollutedEnv());
		assert.equal(env?.PATH, '/usr/bin');
		assert.equal(env?.HOME, '/home/node');
		assert.equal(env?.HTTPS_PROXY, 'http://proxy:8080');
	});

	it('does not mutate the environment it was given', () => {
		const base = pollutedEnv();
		buildAuthEnv({ mode: 'apiKey', secret: 'mine' }, base);
		assert.equal(base.ANTHROPIC_API_KEY, 'host-api-key');
		assert.equal(base.CLAUDE_CODE_OAUTH_TOKEN, 'host-oauth-token');
	});

	it('works from an environment with no auth variables at all', () => {
		const env = buildAuthEnv({ mode: 'apiKey', secret: 'mine' }, { PATH: '/usr/bin' });
		assert.deepEqual(env, { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'mine' });
	});
});

describe('checkAuthSecret', () => {
	it('accepts a filled secret', () => {
		assert.equal(checkAuthSecret('apiKey', 'sk-ant-mine'), null);
	});

	it('rejects an empty or whitespace-only secret, naming the field', () => {
		assert.match(checkAuthSecret('apiKey', '')?.message ?? '', /API Key/);
		assert.match(checkAuthSecret('oauthToken', '   ')?.message ?? '', /OAuth Token/);
	});

	it('describes the fix, including the way back to host auth', () => {
		assert.match(
			checkAuthSecret('oauthToken', '')?.description ?? '',
			/Authentication back to Host/,
		);
	});
});
