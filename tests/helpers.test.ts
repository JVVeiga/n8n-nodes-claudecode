import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudeCodeParams, createFakeContext } from './helpers/executeFunctions';
import { collectRunMetrics } from '../nodes/ClaudeCode/timeout';
import { STREAM_NAMES, streams } from './helpers/sdkMessages';

// The double is the foundation every later test stands on. If it lies about parameter resolution
// or swallows a logger call, every test built on it is worthless — so it gets its own tests.

describe('createFakeContext — input and node', () => {
	it('returns the items it was given', () => {
		const { ctx } = createFakeContext({ items: [{ json: { a: 1 } }, { json: { a: 2 } }] });
		assert.equal(ctx.getInputData().length, 2);
		assert.deepEqual(ctx.getInputData()[1].json, { a: 2 });
	});

	it('defaults to one empty item', () => {
		const { ctx } = createFakeContext();
		assert.deepEqual(ctx.getInputData(), [{ json: {} }]);
	});

	it('exposes typeVersion, which drives the version-aware branches', () => {
		const { ctx } = createFakeContext({ typeVersion: 1 });
		assert.equal(ctx.getNode().typeVersion, 1);
	});

	it('defaults typeVersion to 1.1, the current defaultVersion', () => {
		const { ctx } = createFakeContext();
		assert.equal(ctx.getNode().typeVersion, 1.1);
	});
});

describe('createFakeContext — parameter resolution', () => {
	it('returns a configured value', () => {
		const { ctx } = createFakeContext({ params: { model: 'claude-opus-5' } });
		assert.equal(ctx.getNodeParameter('model', 0), 'claude-opus-5');
	});

	it('falls back when the parameter is absent, matching the real signature', () => {
		const { ctx } = createFakeContext({ params: {} });
		assert.deepEqual(ctx.getNodeParameter('allowedTools', 0, []), []);
	});

	it('prefers the configured value over the fallback', () => {
		const { ctx } = createFakeContext({ params: { effort: 'max' } });
		assert.equal(ctx.getNodeParameter('effort', 0, 'high'), 'max');
	});

	it('throws rather than returning undefined for an unconfigured parameter with no fallback', () => {
		const { ctx } = createFakeContext({ params: {} });
		assert.throws(() => ctx.getNodeParameter('prompt', 0), /no value for parameter 'prompt'/);
	});

	it('resolves a function value per item, so items can differ', () => {
		const { ctx } = createFakeContext({
			items: [{ json: {} }, { json: {} }],
			params: { prompt: (i: number) => `prompt ${i}` },
		});
		assert.equal(ctx.getNodeParameter('prompt', 0), 'prompt 0');
		assert.equal(ctx.getNodeParameter('prompt', 1), 'prompt 1');
	});

	it('records which parameters were read', () => {
		const { ctx, reads } = createFakeContext({ params: claudeCodeParams() });
		ctx.getNodeParameter('operation', 0);
		ctx.getNodeParameter('prompt', 0);
		assert.deepEqual(reads, ['operation', 'prompt']);
	});

	it('setParam replaces a value mid-test', () => {
		const { ctx, setParam } = createFakeContext({ params: { timeout: 300 } });
		assert.equal(ctx.getNodeParameter('timeout', 0), 300);
		setParam('timeout', 5);
		assert.equal(ctx.getNodeParameter('timeout', 0), 5);
	});
});

describe('createFakeContext — continueOnFail and cancellation', () => {
	it('reports continueOnFail as configured', () => {
		assert.equal(createFakeContext().ctx.continueOnFail(), false);
		assert.equal(createFakeContext({ continueOnFail: true }).ctx.continueOnFail(), true);
	});

	it('fires every registered cancellation callback', () => {
		const { ctx, cancel } = createFakeContext();
		let fired = 0;
		ctx.onExecutionCancellation(() => fired++);
		ctx.onExecutionCancellation(() => fired++);
		assert.equal(fired, 0, 'must not fire on registration');
		cancel();
		assert.equal(fired, 2);
	});

	it('aborts a real AbortController, which is what the node registers', () => {
		const { ctx, cancel } = createFakeContext();
		const controller = new AbortController();
		ctx.onExecutionCancellation(() => controller.abort());
		assert.equal(controller.signal.aborted, false);
		cancel();
		assert.equal(controller.signal.aborted, true);
	});
});

describe('createFakeContext — logger', () => {
	it('records calls in order, with their metadata', () => {
		const { ctx, logs } = createFakeContext();
		ctx.logger.debug('first', { a: 1 });
		ctx.logger.error('second');
		assert.equal(logs.length, 2);
		assert.deepEqual(logs[0], { level: 'debug', message: 'first', meta: { a: 1 } });
		assert.deepEqual(logs[1], { level: 'error', message: 'second' });
	});

	it('filters by level', () => {
		const { ctx, logsFor } = createFakeContext();
		ctx.logger.debug('d');
		ctx.logger.error('e');
		ctx.logger.debug('d2');
		assert.equal(logsFor('debug').length, 2);
		assert.equal(logsFor('error').length, 1);
	});
});

describe('createFakeContext — unmodelled members', () => {
	it('throws a directive error rather than returning undefined', () => {
		const { ctx } = createFakeContext();
		assert.throws(() => ctx.getCredentials('anything'), /is not implemented/);
	});
});

describe('sdkMessages — streams are well-formed', () => {
	it('every named stream starts with an init message', () => {
		for (const name of STREAM_NAMES) {
			const first = streams[name]()[0] as { type: string; subtype?: string };
			assert.equal(first.type, 'system', `${name} must open with a system message`);
			assert.equal(first.subtype, 'init', `${name} must open with an init message`);
		}
	});

	it('every named stream survives collectRunMetrics', () => {
		for (const name of STREAM_NAMES) {
			const metrics = collectRunMetrics(streams[name]());
			assert.equal(typeof metrics.usageReliable, 'boolean', name);
			assert.ok('resultText' in metrics, name);
		}
	});

	it('success reports reliable usage and its cost', () => {
		const m = collectRunMetrics(streams.success());
		assert.equal(m.usageReliable, true);
		assert.equal(m.totalCostUsd, 0.0412);
		assert.equal(m.resultText, 'pong');
		assert.equal(m.resultTextSource, 'result');
	});

	it('hardAbort has a result but no usage, so nothing is reliable', () => {
		const m = collectRunMetrics(streams.hardAbort());
		assert.equal(m.usageReliable, false);
		assert.equal(m.totalCostUsd, null);
	});

	it('hardAbortNoResult reports no cost rather than zero', () => {
		const m = collectRunMetrics(streams.hardAbortNoResult());
		assert.equal(m.usageReliable, false);
		assert.equal(m.totalCostUsd, null);
	});

	it('noResult recovers its text from the transcript', () => {
		const m = collectRunMetrics(streams.noResult());
		assert.equal(m.resultText, 'almost done');
		assert.equal(m.resultTextSource, 'assistant');
	});

	it('gracefulTimeout accumulates cost across both result messages', () => {
		const m = collectRunMetrics(streams.gracefulTimeout());
		assert.equal(m.usageReliable, true);
		// The wrap-up result's cumulative total, not the interrupt's.
		assert.equal(m.totalCostUsd, 0.21266249999999998);
		// num_turns restarts per turn, so the run total is the sum.
		assert.equal(m.numTurns, 6);
	});

	it('errorResult always carries a non-empty errors array, which the ladder order depends on', () => {
		for (const name of ['maxTurns', 'duringExecution', 'budgetExceeded'] as const) {
			const result = streams[name]().find((m) => m.type === 'result') as {
				errors?: string[];
				subtype?: string;
			};
			assert.ok(result.errors && result.errors.length > 0, `${name} must carry errors`);
			assert.ok(result.subtype?.startsWith('error_'), `${name} must carry an error subtype`);
		}
	});

	it('ultracode exposes the Workflow tool and uses both Workflow and Task', () => {
		const messages = streams.ultracode();
		const initMsg = messages[0] as { tools?: string[] };
		assert.ok(initMsg.tools?.includes('Workflow'));
		const m = collectRunMetrics(messages);
		assert.deepEqual(
			m.toolTimeline.map((t) => t.name),
			['Workflow', 'Task'],
		);
	});
});
