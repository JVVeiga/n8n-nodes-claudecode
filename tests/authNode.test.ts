import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { INodeExecutionData } from 'n8n-workflow';
import { runItems } from '../nodes/ClaudeCode/ClaudeCode.node';
import { readUsageItems } from '../nodes/ClaudeCodeUsage/ClaudeCodeUsage.node';
import type { UsageReadOptions, UsageReadResult } from '../nodes/ClaudeCodeUsage/readUsage';
import { claudeCodeParams, createFakeContext, type ParamMap } from './helpers/executeFunctions';
import { withFakeQuery } from './helpers/fakeQuery';
import { streams } from './helpers/sdkMessages';

/**
 * Authentication end to end, through both nodes.
 *
 * The unit tests prove `buildAuthEnv` scrubs correctly. These prove the scrubbed environment
 * actually reaches the thing that spawns the CLI — which is the only claim a workflow author cares
 * about — and that the secret reaches nothing else.
 */

const API_SECRET = 'sk-ant-api-SECRET-VALUE';
const OAUTH_SECRET = 'sk-ant-oat01-SECRET-VALUE';

const withApiKey = { claudeCodeApi: { apiKey: API_SECRET } };
const withOAuth = { claudeCodeOAuthTokenApi: { oauthToken: OAUTH_SECRET } };

const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

type QueryCall = { options: { env?: Record<string, string | undefined> } };

async function exec(opts: {
	params?: ParamMap;
	credentials?: Record<string, Record<string, unknown>>;
	items?: INodeExecutionData[];
}) {
	const fake = createFakeContext({
		params: claudeCodeParams(opts.params ?? {}),
		...(opts.credentials ? { credentials: opts.credentials } : {}),
		...(opts.items ? { items: opts.items } : {}),
	});
	let calls: unknown[] = [];
	const result = await withFakeQuery({ messages: streams.success() }, (record, query) => {
		calls = record.calls;
		return runItems(fake.ctx, { query });
	});
	return { items: result[0], calls: calls as QueryCall[], fake };
}

describe('ClaudeCode node — authentication reaches the query', () => {
	it('sends no env at all in host mode', async () => {
		const { calls } = await exec({ params: { authSource: 'host' } });
		assert.equal(has(calls[0].options, 'env'), false);
	});

	it('sends no env when the parameter is absent, as a stored workflow delivers it', async () => {
		const { calls } = await exec({});
		assert.equal(has(calls[0].options, 'env'), false);
	});

	it('sends the API key as ANTHROPIC_API_KEY', async () => {
		const { calls } = await exec({
			params: { authSource: 'apiKey' },
			credentials: withApiKey,
		});
		assert.equal(calls[0].options.env?.ANTHROPIC_API_KEY, API_SECRET);
		assert.equal(has(calls[0].options.env as object, 'CLAUDE_CODE_OAUTH_TOKEN'), false);
		// The environment is a real one, not a two-key object — the CLI has to be able to spawn.
		assert.ok(Object.keys(calls[0].options.env as object).length > 1);
	});

	it('sends the OAuth token as CLAUDE_CODE_OAUTH_TOKEN', async () => {
		const { calls } = await exec({
			params: { authSource: 'oauthToken' },
			credentials: withOAuth,
		});
		assert.equal(calls[0].options.env?.CLAUDE_CODE_OAUTH_TOKEN, OAUTH_SECRET);
		assert.equal(has(calls[0].options.env as object, 'ANTHROPIC_API_KEY'), false);
	});

	it('reports the mode in diagnostics, and nothing for a host run', async () => {
		const credentialed = await exec({
			params: { authSource: 'apiKey' },
			credentials: withApiKey,
		});
		const diagnostics = credentialed.items[0].json.diagnostics as Record<string, unknown>;
		assert.equal(diagnostics.auth, 'apiKey');

		const host = await exec({});
		assert.equal(has(host.items[0].json.diagnostics as object, 'auth'), false);
	});

	it('fails the item when no credential is selected, before anything is spawned', async () => {
		await assert.rejects(
			() => exec({ params: { authSource: 'apiKey' } }),
			/No credential selected/,
		);
	});

	it('fails the item on an empty credential rather than falling back to the host', async () => {
		await assert.rejects(
			() =>
				exec({
					params: { authSource: 'oauthToken' },
					credentials: { claudeCodeOAuthTokenApi: { oauthToken: '  ' } },
				}),
			/no OAuth Token/,
		);
	});

	it('costs no CLI process when the credential is missing', async () => {
		const fake = createFakeContext({
			params: claudeCodeParams({ authSource: 'apiKey' }),
		});
		await withFakeQuery({ messages: streams.success() }, async (record, query) => {
			await assert.rejects(() => runItems(fake.ctx, { query }));
			assert.equal(record.calls.length, 0);
		});
	});
});

describe('ClaudeCode node — the secret stays inside the environment', () => {
	for (const [mode, credentials, secret] of [
		['apiKey', withApiKey, API_SECRET],
		['oauthToken', withOAuth, OAUTH_SECRET],
	] as const) {
		it(`${mode}: never appears in the emitted item or the debug log`, async () => {
			for (const outputFormat of ['structured', 'messages', 'text'] as const) {
				const { items, fake } = await exec({
					params: {
						authSource: mode,
						outputFormat,
						additionalOptions: { debug: true, includeTranscript: true },
					},
					credentials,
				});
				assert.equal(
					JSON.stringify(items).includes(secret),
					false,
					`${outputFormat} item leaked the secret`,
				);
				assert.equal(
					JSON.stringify(fake.logs).includes(secret),
					false,
					`${outputFormat} debug log leaked the secret`,
				);
			}
		});
	}

	it('names the mode in the debug log, so a run is still traceable to a credential', async () => {
		const { fake } = await exec({
			params: { authSource: 'apiKey', additionalOptions: { debug: true } },
			credentials: withApiKey,
		});
		assert.ok(JSON.stringify(fake.logs).includes('"authMode":"apiKey"'));
	});
});

const usageResult = (): UsageReadResult => ({
	init: { apiKeySource: 'temporary' },
	usage: null,
	claudeCodeVersion: null,
	initMs: 1,
	usageMs: 1,
	unsupported: false,
	probeCostUsd: null,
});

const usageParams = (over: ParamMap = {}): ParamMap => ({
	operation: 'read',
	projectPath: '',
	timeout: 30,
	// Off, so a single read is a single call and the cache assertions read cleanly.
	usageOptions: { declareProfileScope: false },
	...over,
});

async function usage(opts: {
	params?: ParamMap;
	credentials?: Record<string, Record<string, unknown>>;
	items?: INodeExecutionData[];
}) {
	const calls: UsageReadOptions[] = [];
	const fake = createFakeContext({
		params: usageParams(opts.params ?? {}),
		...(opts.credentials ? { credentials: opts.credentials } : {}),
		...(opts.items ? { items: opts.items } : {}),
	});
	const result = await readUsageItems(fake.ctx, {
		readUsage: (async (options: UsageReadOptions) => {
			calls.push(options);
			return usageResult();
		}) as never,
	});
	return { items: result[0], calls, fake };
}

describe('Usage node — authentication', () => {
	it('passes no authEnv in host mode', async () => {
		const { calls } = await usage({});
		assert.equal(has(calls[0], 'authEnv'), false);
	});

	it('passes a scrubbed authEnv for a credential', async () => {
		const { calls } = await usage({
			params: { authSource: 'oauthToken' },
			credentials: withOAuth,
		});
		assert.equal(calls[0].authEnv?.CLAUDE_CODE_OAUTH_TOKEN, OAUTH_SECRET);
		assert.equal(has(calls[0].authEnv as object, 'ANTHROPIC_API_KEY'), false);
		assert.equal(calls[0].authEnv?.PATH, process.env.PATH);
	});

	it('caches one read per credential, not one per node', async () => {
		// Two items, one credential: the read is shared, exactly as it is for a project path.
		const shared = await usage({
			params: { authSource: 'apiKey' },
			credentials: withApiKey,
			items: [{ json: {} }, { json: {} }],
		});
		assert.equal(shared.calls.length, 1);
		assert.equal(shared.items.length, 2);
	});

	it('does not serve one credential from another credential’s cached read', async () => {
		// The parameter is a function of itemIndex, which is how n8n delivers a per-item expression.
		const { calls } = await usage({
			params: { authSource: (i: number) => (i === 0 ? 'apiKey' : 'oauthToken') },
			credentials: { ...withApiKey, ...withOAuth },
			items: [{ json: {} }, { json: {} }],
		});
		assert.equal(calls.length, 2);
		assert.equal(calls[0].authEnv?.ANTHROPIC_API_KEY, API_SECRET);
		assert.equal(calls[1].authEnv?.CLAUDE_CODE_OAUTH_TOKEN, OAUTH_SECRET);
	});

	it('fails the item when the credential is empty', async () => {
		await assert.rejects(
			() =>
				usage({
					params: { authSource: 'apiKey' },
					credentials: { claudeCodeApi: { apiKey: '' } },
				}),
			/no API Key/,
		);
	});

	it('never leaks the secret into the emitted report', async () => {
		const { items } = await usage({
			params: { authSource: 'apiKey' },
			credentials: withApiKey,
		});
		assert.equal(JSON.stringify(items).includes(API_SECRET), false);
	});
});
