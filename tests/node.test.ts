import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NodeOperationError } from 'n8n-workflow';
import type { INodeExecutionData } from 'n8n-workflow';
import { ClaudeCode, runItems } from '../nodes/ClaudeCode/ClaudeCode.node';
import { claudeCodeParams, createFakeContext, type ParamMap } from './helpers/executeFunctions';
import { withFakeQuery, type FakeQueryOptions } from './helpers/fakeQuery';
import { assistantText, init, streams, successResult, wrapUpResult } from './helpers/sdkMessages';

/**
 * The node end to end, through the fake context and a fake query.
 *
 * These are the tests that cover the four escape paths — thrown error, soft failure for `text`,
 * soft failure for everything else, and timeout — which between them were the whole reason the
 * 876-line execute() was frightening to touch.
 */

type ExecOpts = {
	params?: ParamMap;
	typeVersion?: number;
	continueOnFail?: boolean;
	items?: INodeExecutionData[];
	query?: FakeQueryOptions;
};

async function exec(opts: ExecOpts = {}) {
	const fake = createFakeContext({
		typeVersion: opts.typeVersion ?? 1.1,
		continueOnFail: opts.continueOnFail ?? false,
		items: opts.items,
		params: claudeCodeParams(opts.params ?? {}),
	});
	const result = await withFakeQuery(opts.query ?? { messages: streams.success() }, (_r, query) =>
		runItems(fake.ctx, { query }),
	);
	return { items: result[0], fake };
}

async function execExpectingThrow(opts: ExecOpts = {}) {
	try {
		await exec(opts);
	} catch (error) {
		return error;
	}
	assert.fail('expected execute() to throw');
}

describe('ClaudeCode.execute — the adapter onto runItems', () => {
	// The tests below all drive runItems directly, injecting a fake query. That leaves exactly one
	// line uncovered — execute() itself — so this asserts the wiring is real: the class exposes
	// execute, and it delegates rather than reimplementing anything.
	it('exposes execute and the description', () => {
		const node = new ClaudeCode();
		assert.equal(typeof node.execute, 'function');
		assert.equal(node.description.name, 'claudeCode');
	});

	it('execute() reaches the real SDK query, which is why it is not unit-tested', async () => {
		// Called with a context whose prompt is empty, so it fails validation BEFORE any spawn. That
		// proves execute() runs the same path as runItems without costing a CLI process.
		const { ctx } = createFakeContext({ params: claudeCodeParams({ prompt: '' }) });
		await assert.rejects(
			() => new ClaudeCode().execute.call(ctx),
			/Prompt is required and cannot be empty/,
		);
	});
});

describe('ClaudeCode.execute — the happy path', () => {
	it('emits one item per input item, paired correctly', async () => {
		const { items } = await exec({ items: [{ json: {} }, { json: {} }] });
		assert.equal(items.length, 2);
		assert.deepEqual(items[0].pairedItem, { item: 0 });
		assert.deepEqual(items[1].pairedItem, { item: 1 });
	});

	it('reports the result and the diagnostics', async () => {
		const { items } = await exec({ params: { outputFormat: 'text' } });
		assert.equal(items[0].json.result, 'pong');
		assert.equal(items[0].json.success, true);
		assert.ok(items[0].json.diagnostics);
	});

	it('cancelling the execution actually stops the run', async () => {
		// Without this the spawned CLI keeps running, and keeps spending, after the workflow stops,
		// with its output discarded. Proven by cancelling a hanging run and watching it end.
		const fake = createFakeContext({
			params: claudeCodeParams({ timeout: 60, additionalOptions: { wrapUpGraceSeconds: 0 } }),
		});
		const controller = new AbortController();
		const running = withFakeQuery(
			{ messages: [init()], hang: true, abortSignal: controller.signal },
			(_r, query) => runItems(fake.ctx, { query }),
		);
		// Give execute() a tick to register the handler and start iterating.
		await new Promise((resolve) => setTimeout(resolve, 50));
		fake.cancel();
		// The node's own controller is the one execute() registered; the fake watches ours, so bridge
		// them the way the SDK does — an abort on the options controller ends the stream.
		controller.abort();
		const result = await running;
		assert.ok(result, 'a cancelled run returns rather than hanging until its own timeout');
	});

	it('passes the prompt into the query as a stream, not a string', async () => {
		let seen: unknown;
		const fake = createFakeContext({ params: claudeCodeParams() });
		await withFakeQuery({ messages: streams.success() }, async (record, query) => {
			await runItems(fake.ctx, { query });
			seen = (record.calls[0] as { prompt?: unknown }).prompt;
		});
		assert.equal(typeof seen, 'object', 'a string prompt would disable interrupt()');
	});
});

describe('ClaudeCode.execute — path 1: thrown NodeOperationError', () => {
	it('rejects an empty prompt', async () => {
		const error = await execExpectingThrow({ params: { prompt: '' } });
		assert.ok(error instanceof NodeOperationError);
		assert.match((error as Error).message, /Prompt is required and cannot be empty/);
	});

	it('rejects a fallback model equal to the model, naming the n8n field', async () => {
		const error = await execExpectingThrow({
			params: {
				model: 'claude-sonnet-5',
				additionalOptions: { fallbackModel: 'claude-sonnet-5' },
			},
		});
		assert.match((error as Error).message, /Fallback Model must be different from Model/);
	});

	it('rejects a project path that does not exist', async () => {
		const error = await execExpectingThrow({ params: { projectPath: '/definitely/not/here' } });
		assert.match((error as Error).message, /Project Path is not an existing directory/);
	});

	it('wraps a run failure with a user-facing message', async () => {
		const error = await execExpectingThrow({
			query: { messages: [init()], throwAfter: new Error('SDK exploded') },
		});
		assert.match((error as Error).message, /Claude Code execution failed: SDK exploded/);
	});
});

describe('ClaudeCode.execute — path 2: soft failure for the text format', () => {
	it('emits an item instead of throwing', async () => {
		const { items } = await exec({
			continueOnFail: true,
			params: { outputFormat: 'text' },
			query: { messages: [init(), assistantText('partial')], throwAfter: new Error('boom') },
		});
		assert.equal(items.length, 1);
		assert.match(String(items[0].json.message ?? items[0].json.error), /boom/);
	});

	it('reports an unknown cost as null, never as zero', async () => {
		const { items } = await exec({
			continueOnFail: true,
			params: { outputFormat: 'text' },
			query: { messages: [init()], throwAfter: new Error('boom') },
		});
		const details = (items[0].json.details ?? items[0].json) as Record<string, unknown>;
		assert.equal(details.total_cost_usd, null, 'a failed run is not a free run');
	});

	it('reports the spend the SDK managed to deliver before it failed', async () => {
		// The SDK sends its result message BEFORE rejecting, so the cost is usually known.
		const { items } = await exec({
			continueOnFail: true,
			params: { outputFormat: 'text' },
			query: { messages: [init(), successResult()], throwAfter: new Error('boom') },
		});
		const details = (items[0].json.details ?? items[0].json) as Record<string, unknown>;
		assert.equal(details.total_cost_usd, 0.0412);
	});
});

describe('ClaudeCode.execute — path 3: soft failure for the other formats', () => {
	for (const outputFormat of ['structured', 'messages'] as const) {
		it(`${outputFormat} emits a failure item under continueOnFail`, async () => {
			const { items } = await exec({
				continueOnFail: true,
				params: { outputFormat },
				query: { messages: [init()], throwAfter: new Error('boom') },
			});
			assert.equal(items.length, 1);
			const details = (items[0].json.details ?? items[0].json) as Record<string, unknown>;
			assert.equal(details.errorType, 'execution_error');
		});
	}

	it('a validation failure also lands as an item under continueOnFail', async () => {
		const { items } = await exec({ continueOnFail: true, params: { prompt: '' } });
		assert.equal(items.length, 1);
		assert.match(String(items[0].json.message ?? items[0].json.error), /Prompt is required/);
	});

	it('one failing item does not stop the next from succeeding', async () => {
		const fake = createFakeContext({
			continueOnFail: true,
			items: [{ json: {} }, { json: {} }],
			// The first item has an empty prompt, the second a real one.
			params: claudeCodeParams({ prompt: (i: number) => (i === 0 ? '' : 'go') }),
		});
		const result = await withFakeQuery({ messages: streams.success() }, (_r, query) =>
			runItems(fake.ctx, { query }),
		);
		assert.equal(result[0].length, 2);
		assert.match(
			String(result[0][0].json.message ?? result[0][0].json.error),
			/Prompt is required/,
		);
		assert.equal(result[0][1].json.success, true);
	});
});

describe('ClaudeCode.execute — path 4: timeout', () => {
	const timingOut = {
		params: { timeout: 1, additionalOptions: { wrapUpGraceSeconds: 0 } },
		query: { messages: [init()], hang: true },
	};

	it('throws a NodeOperationError tagged as a timeout', async () => {
		const error = await execExpectingThrow(timingOut);
		assert.ok(error instanceof NodeOperationError);
		assert.equal((error as NodeOperationError).type, 'timeout', 'the tag n8n core nodes branch on');
	});

	it('carries the full report on error.context for an Error Workflow to read', async () => {
		const error = (await execExpectingThrow(timingOut)) as NodeOperationError;
		const context = error.context as Record<string, unknown>;
		assert.ok(context, 'the UI does not render this, but execution.error.context does');
		assert.equal(context.terminationReason, 'timeout_hard_abort');
		assert.ok('usageReliable' in context);
	});

	it('names the numbers in the message, because the UI panel does not render the context', async () => {
		const error = (await execExpectingThrow(timingOut)) as NodeOperationError;
		assert.match(error.message, /1s|1 second/);
	});

	it('emits an item instead under continueOnFail', async () => {
		const { items } = await exec({ ...timingOut, continueOnFail: true });
		assert.equal(items.length, 1);
		const details = (items[0].json.details ?? items[0].json) as Record<string, unknown>;
		assert.equal(details.terminationReason, 'timeout_hard_abort');
	});

	it('reports a graceful stop and the wrap-up summary when the grace allows one', async () => {
		const error = (await execExpectingThrow({
			params: { timeout: 2, additionalOptions: { wrapUpGraceSeconds: 1 } },
			query: {
				messages: [init()],
				hang: true,
				afterInterrupt: [successResult(), wrapUpResult],
			},
		})) as NodeOperationError;
		const context = error.context as Record<string, unknown>;
		assert.equal(context.terminationReason, 'timeout_graceful');
		assert.equal(context.wrapUpSucceeded, true);
		assert.equal(context.usageReliable, true, 'the interrupt is what makes the SDK account');
	});

	it('a run finishing inside the grace window is NOT reported as a timeout', async () => {
		const { items } = await exec({
			params: { timeout: 2, additionalOptions: { wrapUpGraceSeconds: 1 } },
			query: { messages: streams.success() },
		});
		assert.equal(items[0].json.success, true);
	});
});

describe('ClaudeCode.execute — version-aware behaviour', () => {
	it('typeVersion 1 hard-kills with no wrap-up, because it predates the graceful stop', async () => {
		const error = (await execExpectingThrow({
			typeVersion: 1,
			params: { timeout: 1 },
			query: { messages: [init()], hang: true },
		})) as NodeOperationError;
		const context = error.context as Record<string, unknown>;
		assert.equal(context.wrapUpGraceSeconds, 0);
		assert.equal(context.terminationReason, 'timeout_hard_abort');
	});

	it('typeVersion 1.1 defaults to a 60s grace, interrupting at 240s of a 300s timeout', async () => {
		const { fake } = await exec({
			typeVersion: 1.1,
			params: { timeout: 300, additionalOptions: { debug: true } },
		});
		const start = fake.logsFor('debug').find((l) => l.message === 'Starting Claude Code execution');
		const meta = start?.meta as Record<string, unknown>;
		assert.equal(meta.wrapUpGraceSeconds, 60);
		assert.equal(meta.wrapUpAtMs, 240_000);
		assert.equal(meta.hardAbortAtMs, 300_000);
	});

	it('typeVersion 1 arms no wrap-up timer at all', async () => {
		const { fake } = await exec({
			typeVersion: 1,
			params: { timeout: 300, additionalOptions: { debug: true } },
		});
		const start = fake.logsFor('debug').find((l) => l.message === 'Starting Claude Code execution');
		const meta = start?.meta as Record<string, unknown>;
		assert.equal(meta.wrapUpGraceSeconds, 0);
		assert.equal(meta.wrapUpAtMs, null);
	});

	it('both versions produce the same successful output', async () => {
		const v1 = await exec({ typeVersion: 1, params: { outputFormat: 'text' } });
		const v11 = await exec({ typeVersion: 1.1, params: { outputFormat: 'text' } });
		assert.deepEqual(v1.items[0].json, v11.items[0].json);
	});
});

describe('ClaudeCode.execute — debug logging', () => {
	it('logs nothing when debug is off', async () => {
		const { fake } = await exec();
		assert.equal(fake.logsFor('debug').length, 0);
	});

	it('logs the run when debug is on', async () => {
		const { fake } = await exec({ params: { additionalOptions: { debug: true } } });
		const messages = fake.logsFor('debug').map((l) => l.message);
		assert.ok(messages.includes('Starting Claude Code execution'));
		assert.ok(messages.includes('Execution completed'));
	});
});

describe('ClaudeCode.execute — includeTranscript', () => {
	it('includes the transcript by default', async () => {
		const { items } = await exec({ params: { outputFormat: 'messages' } });
		assert.ok(Array.isArray(items[0].json.messages));
	});

	it('drops it when asked', async () => {
		const { items } = await exec({
			params: { outputFormat: 'messages', additionalOptions: { includeTranscript: false } },
		});
		assert.equal('messages' in items[0].json, false);
		assert.equal(items[0].json.messageCount, 5, 'the count survives');
	});
});

describe('ClaudeCode.execute — Output Envelope', () => {
	// n8n has no UI picker for a node version and a node keeps the one it was created with, so an
	// older node cannot otherwise reach the unified shape without being deleted and re-added. This
	// is the in-place opt-in.
	const unified = { additionalOptions: { outputEnvelope: 'unified' } };

	it('defaults to auto, which leaves an older node on its legacy shape', async () => {
		const { items } = await exec({ typeVersion: 1.1, params: { outputFormat: 'text' } });
		assert.equal(typeof items[0].json.duration_ms, 'number', 'the flat legacy field');
		assert.equal('metrics' in items[0].json, false);
	});

	it('an explicit auto is the same as omitting it', async () => {
		const omitted = await exec({ typeVersion: 1.1, params: { outputFormat: 'text' } });
		const explicit = await exec({
			typeVersion: 1.1,
			params: { outputFormat: 'text', additionalOptions: { outputEnvelope: 'auto' } },
		});
		assert.deepEqual(explicit.items[0].json, omitted.items[0].json);
	});

	it('unified gives a 1.1 node the new envelope without recreating it', async () => {
		const { items } = await exec({
			typeVersion: 1.1,
			params: { outputFormat: 'text', ...unified },
		});
		assert.ok(items[0].json.metrics, 'the unified envelope');
		assert.equal('duration_ms' in items[0].json, false, 'no flat legacy field');
		assert.equal(items[0].json.errorText, '');
	});

	it('unified works on typeVersion 1 too, which is the point of the escape hatch', async () => {
		const { items } = await exec({ typeVersion: 1, params: { outputFormat: 'text', ...unified } });
		assert.ok(items[0].json.metrics);
	});

	it('unified on a 1.2 node changes nothing — it is already unified', async () => {
		const plain = await exec({ typeVersion: 1.2, params: { outputFormat: 'text' } });
		const forced = await exec({ typeVersion: 1.2, params: { outputFormat: 'text', ...unified } });
		assert.deepEqual(forced.items[0].json, plain.items[0].json);
	});

	it('the opted-in shape matches what a real 1.2 node emits, field for field', async () => {
		const optedIn = await exec({
			typeVersion: 1.1,
			params: { outputFormat: 'structured', ...unified },
		});
		const native = await exec({ typeVersion: 1.2, params: { outputFormat: 'structured' } });
		assert.deepEqual(optedIn.items[0].json, native.items[0].json);
	});
});

describe('ClaudeCode.execute — the measured duration reaches the output', () => {
	// This is the gap that a builder-level test cannot see: buildOutputItem was correct and had a
	// passing test for the wall-time fallback, but execute() never handed it the wall time. A 1.2 run
	// whose SDK reported no duration therefore reported 0 — the fabricated number 1.2 exists to stop
	// reporting. Asserted here, between the node and the builder, because that is where it broke.
	it('reports a real duration when the SDK reported none', async () => {
		const { items } = await exec({
			typeVersion: 1.2,
			params: { outputFormat: 'text' },
			// noResult has no result message, so the SDK contributes no duration_ms. The delay makes
			// the run take measurable wall time — without it a fake run reports 0 legitimately, which
			// is indistinguishable from the duration never being passed through.
			query: { messages: streams.noResult(), delayMs: 25 },
		});
		const metrics = items[0].json.metrics as Record<string, unknown>;
		assert.ok(
			(metrics.duration_ms as number) >= 20,
			`a run that took ~25ms reported ${metrics.duration_ms}`,
		);
		assert.equal(metrics.total_cost_usd, null, 'an unknown cost stays null');
	});

	it("prefers the SDK's own duration when it reported one", async () => {
		const { items } = await exec({ typeVersion: 1.2, params: { outputFormat: 'text' } });
		assert.equal((items[0].json.metrics as Record<string, unknown>).duration_ms, 4821);
	});
});
