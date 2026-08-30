import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildQueryOptions, type ConfigDeps } from '../nodes/ClaudeCode/config';
import { buildDiagnostics } from '../nodes/ClaudeCode/diagnostics';
import { readParams } from '../nodes/ClaudeCode/params';
import type { AuthSelection } from '../nodes/shared/auth';
import { claudeCodeParams, createFakeContext, type ParamMap } from './helpers/executeFunctions';
import { createPromptStream } from '../nodes/ClaudeCode/promptStream';
import { streams } from './helpers/sdkMessages';

const HOST_ENV = {
	PATH: '/usr/bin',
	HOME: '/home/node',
	ANTHROPIC_API_KEY: 'the-host-key',
} as NodeJS.ProcessEnv;

const deps = (over: Partial<ConfigDeps> = {}): ConfigDeps => ({
	abortController: new AbortController(),
	promptStream: createPromptStream('hi'),
	onEffort: () => {},
	pathExists: () => true,
	processEnv: HOST_ENV,
	...over,
});

const build = (auth?: AuthSelection, params: ParamMap = {}) => {
	const { ctx } = createFakeContext({ params: claudeCodeParams(params) });
	const outcome = buildQueryOptions(readParams(ctx, 0), deps(auth ? { auth } : {}));
	assert.ok('config' in outcome);
	return outcome.config;
};

const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

describe('config — the authEnv applier', () => {
	it('leaves env unset in host mode, so the subprocess inherits exactly what it always did', () => {
		const config = build({ mode: 'host' });
		assert.equal(has(config.queryOptions.options, 'env'), false);
		assert.equal(config.applied.includes('authEnv'), false);
	});

	it('leaves env unset when no auth reaches it at all', () => {
		// Every call site that predates this feature, and every other test in the suite.
		assert.equal(has(build().queryOptions.options, 'env'), false);
	});

	it('sets a scrubbed environment for an API key', () => {
		const config = build({ mode: 'apiKey', secret: 'sk-ant-mine' });
		assert.equal(config.queryOptions.options.env?.ANTHROPIC_API_KEY, 'sk-ant-mine');
		assert.equal(config.queryOptions.options.env?.PATH, '/usr/bin');
		assert.ok(config.applied.includes('authEnv'));
	});

	it('sets a scrubbed environment for an OAuth token, dropping the host key', () => {
		const config = build({ mode: 'oauthToken', secret: 'sk-ant-oat01-mine' });
		const env = config.queryOptions.options.env as object;
		assert.equal((env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-mine');
		assert.equal(has(env, 'ANTHROPIC_API_KEY'), false);
	});

	it('notes the mode and nothing else', () => {
		const config = build({ mode: 'apiKey', secret: 'sk-ant-secret-value' });
		assert.equal(config.notes.authMode, 'apiKey');
		assert.equal(JSON.stringify(config.notes).includes('sk-ant-secret-value'), false);
	});
});

describe('diagnostics — auth', () => {
	const diagnose = (authMode?: 'host' | 'apiKey' | 'oauthToken') => {
		const { ctx } = createFakeContext({ params: claudeCodeParams() });
		return buildDiagnostics({
			messages: streams.success(),
			params: readParams(ctx, 0),
			permissionMode: 'bypassPermissions',
			appliedEffort: null,
			...(authMode ? { authMode } : {}),
		});
	};

	// The reason this feature needed no new typeVersion: a host run's diagnostics object has to be
	// the same object it was before, own properties included, or the 48 golden fixtures move.
	it('has no auth own property for a host run', () => {
		assert.equal(has(diagnose('host'), 'auth'), false);
		assert.equal(has(diagnose(), 'auth'), false);
	});

	it('reports the mode when a credential was used', () => {
		assert.equal(diagnose('apiKey').auth, 'apiKey');
		assert.equal(diagnose('oauthToken').auth, 'oauthToken');
	});
});
