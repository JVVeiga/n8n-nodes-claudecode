import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAgentDiagnostics } from '../nodes/ClaudeCodeAgent/output';
import { readParams } from '../nodes/ClaudeCode/params';
import { claudeCodeParams, createFakeContext } from './helpers/executeFunctions';
import { streams } from './helpers/sdkMessages';

const paramsFor = (over: Record<string, unknown> = {}, typeVersion = 1.1) => {
	const { ctx } = createFakeContext({ typeVersion, params: claudeCodeParams(over) });
	return readParams(ctx, 0);
};

describe('buildAgentDiagnostics — optional agent fields', () => {
	const base = () => ({
		messages: streams.success(),
		params: paramsFor(),
		permissionMode: 'bypassPermissions',
		appliedEffort: null,
	});
	const NEW_KEYS = [
		'subagents',
		'bridgedTools',
		'instructions',
		'structuredOutput',
		'sessionState',
	];

	it('without extra, none of the new keys exists and the shape is unchanged', () => {
		const plain = buildAgentDiagnostics(base());
		for (const key of NEW_KEYS) assert.equal(key in plain, false, `${key} must be absent`);
		assert.deepEqual(buildAgentDiagnostics({ ...base(), extra: {} }), plain);
		assert.deepEqual(
			buildAgentDiagnostics({
				...base(),
				extra: {
					subagents: undefined,
					bridgedTools: undefined,
					instructions: undefined,
					structuredOutput: undefined,
					sessionState: undefined,
				},
			}),
			plain,
			'an undefined field is not an own property',
		);
	});

	it('each field appears only when given', () => {
		const given = {
			subagents: [
				{
					name: 'reviewer',
					invocations: 1,
					completed: 1,
					totalTokens: 1200,
					toolUses: 3,
					durationMs: 4000,
				},
			],
			bridgedTools: ['mcp__n8n__calculator'],
			instructions: { loaded: ['AGENTS.md'], missing: ['.review/rules.md'] },
			structuredOutput: { mode: 'parser', attempts: 1 },
			sessionState: 'created' as const,
		};
		const plainKeys = Object.keys(buildAgentDiagnostics(base()));
		for (const [key, value] of Object.entries(given)) {
			const d = buildAgentDiagnostics({ ...base(), extra: { [key]: value } });
			assert.deepEqual((d as Record<string, unknown>)[key], value);
			assert.deepEqual(Object.keys(d), [...plainKeys, key], `only ${key} is added`);
		}
	});
});
