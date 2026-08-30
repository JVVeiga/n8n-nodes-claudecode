import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readAuth } from '../nodes/shared/readAuth';
import { claudeCodeParams, createFakeContext } from './helpers/executeFunctions';

const read = async (
	params: Record<string, unknown>,
	credentials?: Record<string, Record<string, unknown>>,
) => {
	const { ctx, reads } = createFakeContext({
		params: claudeCodeParams(params),
		...(credentials ? { credentials } : {}),
	});
	return { outcome: await readAuth(ctx, 0), reads };
};

describe('readAuth', () => {
	it('defaults to host when the parameter is absent, as a stored workflow delivers it', async () => {
		const { outcome } = await read({});
		assert.deepEqual(outcome, { auth: { mode: 'host' } });
	});

	it('never asks for a credential in host mode', async () => {
		// No credentials map at all: if it reached getCredentials the double would throw.
		const { outcome } = await read({ authSource: 'host' });
		assert.deepEqual(outcome, { auth: { mode: 'host' } });
	});

	it('reads the API key credential', async () => {
		const { outcome } = await read(
			{ authSource: 'apiKey' },
			{ claudeCodeApi: { apiKey: 'sk-ant-mine' } },
		);
		assert.deepEqual(outcome, { auth: { mode: 'apiKey', secret: 'sk-ant-mine' } });
	});

	it('reads the OAuth token credential', async () => {
		const { outcome } = await read(
			{ authSource: 'oauthToken' },
			{ claudeCodeOAuthTokenApi: { oauthToken: 'sk-ant-oat01-mine' } },
		);
		assert.deepEqual(outcome, { auth: { mode: 'oauthToken', secret: 'sk-ant-oat01-mine' } });
	});

	it('trims a pasted secret', async () => {
		const { outcome } = await read(
			{ authSource: 'apiKey' },
			{ claudeCodeApi: { apiKey: '  sk-ant-mine\n' } },
		);
		assert.deepEqual(outcome, { auth: { mode: 'apiKey', secret: 'sk-ant-mine' } });
	});

	it('reports a Problem when no credential is selected, rather than rejecting', async () => {
		const { outcome } = await read({ authSource: 'apiKey' });
		assert.ok('problem' in outcome);
		assert.match(outcome.problem.message, /No credential selected/);
		assert.match(outcome.problem.description ?? '', /Authentication to Host/);
	});

	it('reports a Problem for an empty secret instead of falling back to the host', async () => {
		const { outcome } = await read(
			{ authSource: 'oauthToken' },
			{ claudeCodeOAuthTokenApi: { oauthToken: '   ' } },
		);
		assert.ok('problem' in outcome);
		assert.match(outcome.problem.message, /no OAuth Token/);
	});

	it('reports a Problem when the credential carries the wrong field', async () => {
		const { outcome } = await read({ authSource: 'apiKey' }, { claudeCodeApi: { token: 'x' } });
		assert.ok('problem' in outcome);
	});

	it('treats an unrecognised mode as host', async () => {
		const { outcome } = await read({ authSource: 'bedrock' });
		assert.deepEqual(outcome, { auth: { mode: 'host' } });
	});
});
