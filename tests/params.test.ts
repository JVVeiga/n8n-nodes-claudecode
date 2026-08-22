import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	checkPrompt,
	defaultGraceSeconds,
	effectiveEffort,
	isUltracode,
	readParams,
} from '../nodes/ClaudeCode/params';
import type { ClaudeCodeParams } from '../nodes/ClaudeCode/types';
import { claudeCodeParams, createFakeContext } from './helpers/executeFunctions';

const read = (over: Record<string, unknown> = {}, typeVersion = 1.1): ClaudeCodeParams => {
	const { ctx } = createFakeContext({ typeVersion, params: claudeCodeParams(over) });
	return readParams(ctx, 0);
};

describe('readParams', () => {
	it('reads every parameter into one typed object', () => {
		const p = read({
			operation: 'continue',
			prompt: 'do the thing',
			model: 'claude-opus-5',
			effort: 'max',
			maxTurns: 12,
			timeout: 900,
			projectPath: '/workspace',
			outputFormat: 'text',
			allowedTools: ['Bash'],
			disallowedTools: ['Write'],
			restrictTools: ['Read'],
			sessionId: 'abc-123',
		});
		assert.equal(p.operation, 'continue');
		assert.equal(p.prompt, 'do the thing');
		assert.equal(p.model, 'claude-opus-5');
		assert.equal(p.effort, 'max');
		assert.equal(p.maxTurns, 12);
		assert.equal(p.timeoutSeconds, 900);
		assert.equal(p.projectPath, '/workspace');
		assert.equal(p.outputFormat, 'text');
		assert.deepEqual(p.allowedTools, ['Bash']);
		assert.deepEqual(p.disallowedTools, ['Write']);
		assert.deepEqual(p.restrictTools, ['Read']);
		assert.equal(p.sessionId, 'abc-123');
	});

	it('carries the item index and node version, which later stages branch on', () => {
		const { ctx } = createFakeContext({ typeVersion: 1, params: claudeCodeParams() });
		const p = readParams(ctx, 3);
		assert.equal(p.itemIndex, 3);
		assert.equal(p.nodeVersion, 1);
	});

	it('trims the session id — a pasted value picks up whitespace', () => {
		assert.equal(read({ sessionId: '  abc-123  ' }).sessionId, 'abc-123');
	});

	it('reads sessionId even for a query operation, so the shape never varies', () => {
		// Read conditionally, the params object's shape depended on the operation and every
		// consumer had to know that. It is always present, empty when unset.
		assert.equal(read({ operation: 'query' }).sessionId, '');
	});

	it('defaults the tool lists to empty arrays rather than undefined', () => {
		const { ctx } = createFakeContext({
			params: {
				operation: 'query',
				prompt: 'x',
				model: 'sonnet',
				maxTurns: 5,
				timeout: 300,
				projectPath: '',
				outputFormat: 'structured',
				additionalOptions: {},
			},
		});
		const p = readParams(ctx, 0);
		assert.deepEqual(p.allowedTools, []);
		assert.deepEqual(p.disallowedTools, []);
		assert.deepEqual(p.restrictTools, []);
	});

	it("defaults effort to high, matching the schema's own default", () => {
		const withoutEffort = claudeCodeParams();
		delete withoutEffort.effort;
		const { ctx } = createFakeContext({ params: withoutEffort });
		assert.equal(readParams(ctx, 0).effort, 'high');
	});
});

describe('readParams — the version-aware grace default', () => {
	it('resolves to 60 on 1.1, where the graceful stop exists', () => {
		assert.equal(read({}, 1.1).additional.wrapUpGraceSeconds, 60);
	});

	it('resolves to 0 on 1, which predates the graceful stop and must keep hard-killing', () => {
		assert.equal(read({}, 1).additional.wrapUpGraceSeconds, 0);
	});

	it('an explicit value wins over the version default, including an explicit 0 on 1.1', () => {
		assert.equal(
			read({ additionalOptions: { wrapUpGraceSeconds: 30 } }, 1.1).additional.wrapUpGraceSeconds,
			30,
		);
		assert.equal(
			read({ additionalOptions: { wrapUpGraceSeconds: 0 } }, 1.1).additional.wrapUpGraceSeconds,
			0,
		);
	});

	it('defaultGraceSeconds is the whole rule, in one place', () => {
		assert.equal(defaultGraceSeconds(1), 0);
		assert.equal(defaultGraceSeconds(1.1), 60);
		// A future version inherits 1.1's behaviour rather than silently reverting to 0.
		assert.equal(defaultGraceSeconds(1.2), 60);
	});

	it('preserves the other collection fields while defaulting the grace', () => {
		const p = read({ additionalOptions: { debug: true, maxBudgetUsd: 5 } }, 1.1);
		assert.equal(p.additional.debug, true);
		assert.equal(p.additional.maxBudgetUsd, 5);
		assert.equal(p.additional.wrapUpGraceSeconds, 60);
	});
});

describe('effort translation', () => {
	it('ultracode is not an SDK level and is translated to xhigh', () => {
		const p = read({ effort: 'ultracode' });
		assert.equal(isUltracode(p), true);
		assert.equal(effectiveEffort(p), 'xhigh');
	});

	for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
		it(`${level} passes through untouched`, () => {
			const p = read({ effort: level });
			assert.equal(isUltracode(p), false);
			assert.equal(effectiveEffort(p), level);
		});
	}
});

describe('checkPrompt', () => {
	it('accepts a real prompt', () => {
		assert.equal(checkPrompt('do the thing'), null);
	});

	it('rejects empty and whitespace-only, which is what an expression resolves to', () => {
		for (const value of ['', '   ', '\n\t']) {
			const problem = checkPrompt(value);
			assert.ok(problem, JSON.stringify(value));
			assert.equal(problem.message, 'Prompt is required and cannot be empty');
		}
	});

	it('carries no description — the pre-refactor error had none, and adding one would change what n8n shows', () => {
		assert.equal(checkPrompt('')?.description, undefined);
	});
});
