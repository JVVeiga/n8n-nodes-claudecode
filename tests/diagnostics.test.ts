import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDiagnostics } from '../nodes/ClaudeCode/diagnostics';
import { readParams } from '../nodes/ClaudeCode/params';
import { claudeCodeParams, createFakeContext } from './helpers/executeFunctions';
import { init, streams } from './helpers/sdkMessages';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const paramsFor = (over: Record<string, unknown> = {}, typeVersion = 1.1) => {
	const { ctx } = createFakeContext({ typeVersion, params: claudeCodeParams(over) });
	return readParams(ctx, 0);
};

const build = (
	messages: SDKMessage[],
	over: Record<string, unknown> = {},
	extra: { permissionMode?: string; appliedEffort?: string | null } = {},
) =>
	buildDiagnostics({
		messages,
		params: paramsFor(over),
		permissionMode: extra.permissionMode ?? 'bypassPermissions',
		appliedEffort: extra.appliedEffort ?? null,
	});

describe('buildDiagnostics — what was asked for', () => {
	it('reports the requested model verbatim', () => {
		assert.equal(
			build(streams.success(), { model: 'claude-opus-5' }).requestedModel,
			'claude-opus-5',
		);
	});

	it('reports the requested effort, before translation', () => {
		const d = build(streams.success(), { effort: 'ultracode' });
		assert.equal(d.requestedEffort, 'ultracode');
		assert.equal(d.effectiveEffort, 'xhigh', 'the SDK never sees "ultracode"');
		assert.equal(d.ultracodeRequested, true);
	});

	it('reports the fallback model as null when none was chosen, not an empty string', () => {
		assert.equal(build(streams.success()).fallbackModelRequested, null);
		assert.equal(
			build(streams.success(), { additionalOptions: { fallbackModel: '' } }).fallbackModelRequested,
			null,
			'the None option has value "" and must not read as a requested fallback',
		);
		assert.equal(
			build(streams.success(), { additionalOptions: { fallbackModel: 'haiku' } })
				.fallbackModelRequested,
			'haiku',
		);
	});

	it("reports the thinking selection, defaulting to 'default'", () => {
		assert.equal(build(streams.success()).thinkingRequested, 'default');
		assert.equal(
			build(streams.success(), { additionalOptions: { thinking: 'summarized' } }).thinkingRequested,
			'summarized',
		);
	});

	it('reports the permission mode it was given, which is resolved elsewhere', () => {
		assert.equal(build(streams.success(), {}, { permissionMode: 'plan' }).permissionMode, 'plan');
	});
});

describe('buildDiagnostics — what actually happened', () => {
	it('reports the model the CLI resolved to, from the init message', () => {
		assert.equal(build(streams.success()).resolvedModel, 'claude-sonnet-5');
	});

	it('reports modelsUsed from modelUsage, which does reflect a mid-run fallback switch', () => {
		assert.deepEqual(build(streams.success()).modelsUsed, ['claude-sonnet-5']);
	});

	it('modelsUsed is empty rather than null when no result arrived', () => {
		assert.deepEqual(build(streams.hardAbortNoResult()).modelsUsed, []);
	});

	it('reports appliedEffort only when a hook fired', () => {
		assert.equal(build(streams.success()).appliedEffort, null);
		assert.equal(build(streams.success(), {}, { appliedEffort: 'high' }).appliedEffort, 'high');
	});

	it('takes the session id from the result, falling back to the init message', () => {
		assert.equal(
			build(streams.success()).sessionId,
			'1e76098f-2bf5-424d-9694-d1feab1cfc12',
			'from the result message',
		);
		assert.equal(
			build(streams.hardAbortNoResult()).sessionId,
			'1e76098f-2bf5-424d-9694-d1feab1cfc12',
			'from init when there is no result — a hard abort still has a session worth resuming',
		);
	});

	it('reports no session id when there is nothing to report', () => {
		assert.equal(build([]).sessionId, null);
	});
});

describe('buildDiagnostics — Ultracode evidence', () => {
	it('reports whether the CLI loaded the Workflow tool, from the init tool list', () => {
		assert.equal(build(streams.ultracode()).workflowToolAvailable, true);
		assert.equal(build(streams.maxTurns()).workflowToolAvailable, false);
	});

	it('counts Workflow and Task uses separately', () => {
		const d = build(streams.ultracode());
		assert.equal(d.workflowToolUses, 1);
		assert.equal(d.subagentToolUses, 1);
	});

	it('counts thinking blocks', () => {
		assert.equal(build(streams.ultracode()).thinkingBlocks, 1);
		assert.equal(build(streams.success()).thinkingBlocks, 0);
	});

	it('reports zero uses rather than undefined on a run that used no tools', () => {
		const d = build(streams.empty());
		assert.equal(d.workflowToolUses, 0);
		assert.equal(d.subagentToolUses, 0);
		assert.equal(d.thinkingBlocks, 0);
	});
});

describe('buildDiagnostics — the degenerate cases every error path hits', () => {
	// The failure and timeout paths call this with whatever arrived, which can be nothing at all.
	// Every field must be present and JSON-safe, and absent data must read as null, never undefined.
	const EXPECTED_KEYS = [
		'appliedEffort',
		'effectiveEffort',
		'fallbackModelRequested',
		'modelsUsed',
		'permissionMode',
		'requestedEffort',
		'requestedModel',
		'resolvedModel',
		'sessionId',
		'subagentToolUses',
		'thinkingBlocks',
		'thinkingRequested',
		'ultracodeRequested',
		'workflowToolAvailable',
		'workflowToolUses',
	];

	for (const [label, messages] of [
		['no messages at all', [] as SDKMessage[]],
		['only an init message', [init()]],
		['a hard abort with no result', streams.hardAbortNoResult()],
	] as const) {
		it(`${label}: every field present, nothing undefined`, () => {
			const d = build(messages as SDKMessage[]);
			assert.deepEqual(Object.keys(d).sort(), EXPECTED_KEYS);
			for (const [key, value] of Object.entries(d)) {
				assert.notEqual(value, undefined, `${key} is undefined`);
			}
			assert.doesNotThrow(() => JSON.stringify(d));
		});
	}

	it('resolvedModel is null, not undefined, when there is no init message', () => {
		assert.equal(build([]).resolvedModel, null);
	});
});
