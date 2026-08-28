import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { INodeProperties } from 'n8n-workflow';
import { claudeCodeUsageDescription } from '../nodes/ClaudeCodeUsage/description';
import { createFakeContext, type ParamMap } from './helpers/executeFunctions';
import { readUsageItems, ClaudeCodeUsage } from '../nodes/ClaudeCodeUsage/ClaudeCodeUsage.node';
import { UsageReadTimeoutError, type UsageReadResult } from '../nodes/ClaudeCodeUsage/readUsage';
import type { INodeExecutionData } from 'n8n-workflow';
import { createDebugLogger } from '../nodes/shared/debug';
import { checkProjectPath } from '../nodes/shared/projectPath';

/**
 * The Usage node's schema and the shared helpers it now uses.
 *
 * Its execute() spawns a real CLI through readUsage, which is why readUsage is explicitly out of
 * scope (spec N-3): faking it would mean faking the SDK's control-request surface, and the Docker
 * suite already exercises the real thing. What is tested here is the contract every workflow reads
 * — the schema — plus the fact that the node no longer carries its own copies of the shared logic.
 */

const props = claudeCodeUsageDescription.properties;
const byName = (name: string): INodeProperties => {
	const found = props.find((p) => p.name === name);
	assert.ok(found, `no parameter named '${name}'`);
	return found;
};
const optionFields = (name: string): INodeProperties[] =>
	(byName(name).options ?? []) as INodeProperties[];

describe('Usage node description — identity', () => {
	it('keeps the name workflows are stored against', () => {
		assert.equal(claudeCodeUsageDescription.name, 'claudeCodeUsage');
		assert.equal(claudeCodeUsageDescription.displayName, 'Claude Code Usage');
	});

	it('has one main input and output', () => {
		assert.equal(claudeCodeUsageDescription.inputs.length, 1);
		assert.equal(claudeCodeUsageDescription.outputs.length, 1);
	});
});

describe('Usage node description — parameters', () => {
	const EXPECTED = ['operation', 'projectPath', 'timeout', 'usageOptions'];

	it('has exactly the expected parameters, in order', () => {
		assert.deepEqual(
			props.map((p) => p.name),
			EXPECTED,
		);
	});

	it('projectPath defaults to empty, meaning leave cwd alone', () => {
		assert.equal(byName('projectPath').default, '');
	});

	it('usageOptions is a collection', () => {
		assert.equal(byName('usageOptions').type, 'collection');
	});
});

describe('Usage node description — the options collection', () => {
	const EXPECTED = [
		'debug',
		'declareProfileScope',
		'errorIfLimitsUnavailable',
		'includeAccountEmail',
		'includeRawLimits',
		'pathToClaudeCodeExecutable',
		'probeIfUnavailable',
	];

	it('has exactly the expected fields', () => {
		assert.deepEqual(
			optionFields('usageOptions')
				.map((f) => f.name)
				.sort(),
			EXPECTED,
		);
	});

	it('the probe is opt-in, because it costs real money', () => {
		// It sends one trivial turn so the API response carries rate-limit headers. A fraction of a
		// cent, but not free, so it must never default on.
		const probe = optionFields('usageOptions').find((f) => f.name === 'probeIfUnavailable');
		assert.equal(probe?.default, false);
	});

	it('declaring the profile scope is on by default, since it costs nothing', () => {
		// A token session is told it may only infer, so the CLI never asks about plan limits.
		// Asking again with the scope declared is free when it fails.
		const scope = optionFields('usageOptions').find((f) => f.name === 'declareProfileScope');
		assert.equal(scope?.default, true);
	});

	it('the account email is opt-in — it is personal data nobody asked to log', () => {
		const email = optionFields('usageOptions').find((f) => f.name === 'includeAccountEmail');
		assert.equal(email?.default, false);
	});
});

describe('Usage node — no duplicated logic left', () => {
	it('reads its project path through the shared validator', () => {
		// Both nodes carried a byte-identical statSync().isDirectory() check plus its message and its
		// "mount it in Docker" description. Asserted by behaviour: the Usage node must now reject a
		// bad path with exactly the shared message.
		const problem = checkProjectPath('/definitely/not/here');
		assert.ok(problem);
		assert.match(problem.message, /Project Path is not an existing directory/);
	});

	it('gates its debug logging through the shared logger', () => {
		// The node has exactly one debug site and it goes through createDebugLogger, so the payload
		// is not built when debug is off.
		const { ctx, logs } = createFakeContext();
		let built = 0;
		createDebugLogger(ctx.logger, false).lazy('Claude Code usage read', () => {
			built++;
			return {};
		});
		assert.equal(built, 0);
		assert.equal(logs.length, 0);
	});
});

/**
 * The Usage node's execute path, which had no coverage at all until now.
 *
 * `readUsage` is injected (spec N-3 keeps it untested — it spawns a real CLI), which makes
 * everything around it assertable: the per-path read cache, the scope-retry then probe escalation,
 * and the four different explanations the node gives for "no plan limits".
 */

const TEAM_INIT = {
	account: {
		email: 'someone@example.com',
		organization: 'Gaudium',
		subscriptionType: 'Claude Team',
		apiProvider: 'firstParty',
	},
	models: [{ id: 'claude-opus-5' }],
};

const withLimits = {
	session: { total_cost_usd: 0, total_duration_ms: 2111, model_usage: {} },
	subscription_type: 'team',
	rate_limits_available: true,
	rate_limits: {
		five_hour: { utilization: 40, resets_at: '2026-08-22T10:00:00Z' },
		// `limits` is the raw bucket array the CLI echoes back, and the only thing includeRawLimits
		// surfaces — the normalised windows come from the named keys above.
		limits: [{ bucket: 'five_hour', utilization: 40 }],
	},
};

const withoutLimits = {
	session: { total_cost_usd: 0, total_duration_ms: 2111, model_usage: {} },
	subscription_type: 'team',
	rate_limits_available: false,
};

/**
 * The retry only fires for a token session: shouldRetryWithProfileScope requires
 * tokenSource === 'CLAUDE_CODE_OAUTH_TOKEN', because that is the credential the CLI hands a
 * scope record of `user:inference` alone. Any other login already carries its real scopes, so
 * asking again would just cost another session for nothing.
 */
const TOKEN_INIT = {
	...TEAM_INIT,
	account: { ...TEAM_INIT.account, tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' },
};

const read = (over: Partial<UsageReadResult> = {}): UsageReadResult => ({
	init: TEAM_INIT,
	usage: withLimits,
	claudeCodeVersion: null,
	initMs: 120,
	usageMs: 80,
	unsupported: false,
	probeCostUsd: null,
	...over,
});

type FakeRead = {
	fn: (options: Record<string, unknown>) => Promise<UsageReadResult>;
	calls: Array<Record<string, unknown>>;
};

/** A readUsage stand-in that records its calls and answers from a scripted queue. */
const fakeRead = (queue: Array<UsageReadResult | Error>): FakeRead => {
	const calls: Array<Record<string, unknown>> = [];
	let i = 0;
	return {
		calls,
		fn: async (options) => {
			calls.push(options);
			const next = queue[Math.min(i++, queue.length - 1)];
			if (next instanceof Error) throw next;
			return next;
		},
	};
};

const usageParams = (over: ParamMap = {}): ParamMap => ({
	operation: 'read',
	projectPath: '',
	timeout: 30,
	usageOptions: {},
	...over,
});

async function runUsage(opts: {
	queue: Array<UsageReadResult | Error>;
	params?: ParamMap;
	items?: INodeExecutionData[];
}) {
	const fake = fakeRead(opts.queue);
	const ctxWrap = createFakeContext({
		items: opts.items,
		params: usageParams(opts.params ?? {}),
	});
	const result = await readUsageItems(ctxWrap.ctx, {
		readUsage: fake.fn as never,
	});
	return { items: result[0], reads: fake.calls, fake, ctxWrap };
}

describe('Usage node execute — the happy path', () => {
	it('emits one normalised report per item', async () => {
		const { items } = await runUsage({ queue: [read()], items: [{ json: {} }, { json: {} }] });
		assert.equal(items.length, 2);
		assert.equal(items[0].json.rateLimitsAvailable, true);
		assert.deepEqual(items[0].pairedItem, { item: 0 });
		assert.deepEqual(items[1].pairedItem, { item: 1 });
	});

	it('withholds the account email unless asked', async () => {
		const off = await runUsage({ queue: [read()] });
		assert.equal('email' in (off.items[0].json.account as object), false);

		const on = await runUsage({
			queue: [read()],
			params: { usageOptions: { includeAccountEmail: true } },
		});
		assert.equal((on.items[0].json.account as { email?: string }).email, 'someone@example.com');
	});

	it('omits the raw limits payload unless asked', async () => {
		const off = await runUsage({ queue: [read()] });
		assert.equal('limitsRaw' in off.items[0].json, false);

		const on = await runUsage({
			queue: [read()],
			params: { usageOptions: { includeRawLimits: true } },
		});
		assert.ok('limitsRaw' in on.items[0].json);
	});
});

describe('Usage node execute — the per-path read cache', () => {
	it('serves N items from ONE read — plan capacity is account-wide', async () => {
		// N items must not open N sessions at ~2s each.
		const { items, reads } = await runUsage({
			queue: [read()],
			items: [{ json: {} }, { json: {} }, { json: {} }],
		});
		assert.equal(items.length, 3);
		assert.equal(reads.length, 1, 'one CLI session for three items');
	});

	it('gives every item served by one read the SAME fetchedAt', async () => {
		// Every countdown in an item is derived from it, so two items from one read must agree.
		const { items } = await runUsage({
			queue: [read()],
			items: [{ json: {} }, { json: {} }],
		});
		assert.equal(items[0].json.fetchedAt, items[1].json.fetchedAt);
	});

	it('reads again for a different project path — settings and hooks resolve per directory', async () => {
		const { reads } = await runUsage({
			queue: [read()],
			items: [{ json: {} }, { json: {} }],
			params: { projectPath: (i: number) => (i === 0 ? process.cwd() : '') },
		});
		assert.equal(reads.length, 2);
	});

	it('reads again when the timeout differs, because it is part of the cache key', async () => {
		const { reads } = await runUsage({
			queue: [read()],
			items: [{ json: {} }, { json: {} }],
			params: { timeout: (i: number) => (i === 0 ? 30 : 60) },
		});
		assert.equal(reads.length, 2);
	});
});

describe('Usage node execute — the escalation ladder', () => {
	it('does not retry when the first read already has limits', async () => {
		const { reads, items } = await runUsage({ queue: [read()] });
		assert.equal(reads.length, 1);
		assert.equal(
			(items[0].json.diagnostics as { scopeRetried?: boolean }).scopeRetried,
			undefined,
			'no retry means no marker',
		);
	});

	it('retries with the profile scope declared when limits are missing', async () => {
		// A token session is told it may only infer, so the CLI never asks about plan limits.
		const { reads, items } = await runUsage({
			queue: [read({ init: TOKEN_INIT, usage: withoutLimits }), read()],
		});
		assert.equal(reads.length, 2);
		assert.match(String(reads[1].oauthScopes), /user:profile/);
		assert.equal((items[0].json.diagnostics as { scopeRetried?: boolean }).scopeRetried, true);
	});

	it('skips the retry entirely when the option is off', async () => {
		const { reads } = await runUsage({
			queue: [read({ init: TOKEN_INIT, usage: withoutLimits })],
			params: { usageOptions: { declareProfileScope: false } },
		});
		assert.equal(reads.length, 1);
	});

	it('does not probe unless asked, even when the retry found nothing', async () => {
		// The probe costs real money, so it must never happen by default.
		const { reads } = await runUsage({
			queue: [
				read({ init: TOKEN_INIT, usage: withoutLimits }),
				read({ init: TOKEN_INIT, usage: withoutLimits }),
			],
		});
		assert.equal(reads.length, 2, 'retry only, no probe');
		assert.equal(
			reads.every((r) => !r.probePrompt),
			true,
		);
	});

	it('probes as a last resort when asked and the retry still found nothing', async () => {
		const { reads, items } = await runUsage({
			queue: [
				read({ init: TOKEN_INIT, usage: withoutLimits }),
				read({ init: TOKEN_INIT, usage: withoutLimits }),
				read({ probeCostUsd: 0.001136 }),
			],
			params: { usageOptions: { probeIfUnavailable: true } },
		});
		assert.equal(reads.length, 3);
		assert.ok(reads[2].probePrompt, 'the third read sends a turn');
		const diagnostics = items[0].json.diagnostics as { probed?: boolean; probeCostUsd?: number };
		assert.equal(diagnostics.probed, true);
		assert.equal(diagnostics.probeCostUsd, 0.001136);
	});

	it('does not probe when the retry succeeded', async () => {
		const { reads } = await runUsage({
			queue: [read({ init: TOKEN_INIT, usage: withoutLimits }), read()],
			params: { usageOptions: { probeIfUnavailable: true } },
		});
		assert.equal(reads.length, 2, 'the retry found limits, so the probe is unnecessary');
	});

	it('a batch pays for the escalation once', async () => {
		const { reads } = await runUsage({
			queue: [read({ init: TOKEN_INIT, usage: withoutLimits }), read()],
			items: [{ json: {} }, { json: {} }, { json: {} }],
		});
		assert.equal(reads.length, 2, 'the escalation lives inside the cached promise');
	});
});

describe('Usage node execute — error mapping', () => {
	it('rejects a project path that does not exist, before spawning anything', async () => {
		const fake = fakeRead([read()]);
		const { ctx } = createFakeContext({
			params: usageParams({ projectPath: '/definitely/not/here' }),
		});
		await assert.rejects(
			() => readUsageItems(ctx, { readUsage: fake.fn as never }),
			/Project Path is not an existing directory/,
		);
		assert.equal(fake.calls.length, 0, 'no CLI session for a bad path');
	});

	for (const [stage, pattern] of [
		['initialize', /slow SessionStart hook/],
		['probe', /no rate-limit headers/],
		['usage', /answered but the usage request did not/],
	] as const) {
		it(`a ${stage} timeout gets its own explanation`, async () => {
			// Three stages, three different fixes — a generic "it timed out" would help nobody.
			const error = new UsageReadTimeoutError(stage, 30_000);
			const { ctx } = createFakeContext({ params: usageParams() });
			await assert.rejects(async () => {
				try {
					await readUsageItems(ctx, {
						readUsage: (async () => {
							throw error;
						}) as never,
					});
				} catch (thrown) {
					assert.match((thrown as { description: string }).description, pattern);
					throw thrown;
				}
			});
		});
	}

	it('wraps any other read failure with what to check', async () => {
		const { ctx } = createFakeContext({ params: usageParams() });
		await assert.rejects(
			() =>
				readUsageItems(ctx, {
					readUsage: (async () => {
						throw new Error('boom');
					}) as never,
				}),
			/Could not read Claude usage: boom/,
		);
	});
});

describe('Usage node execute — errorIfLimitsUnavailable picks the right explanation', () => {
	const failFor = async (over: Partial<UsageReadResult>, initOver?: object) => {
		const { ctx } = createFakeContext({
			params: usageParams({
				usageOptions: { errorIfLimitsUnavailable: true, declareProfileScope: false },
			}),
		});
		const result = read(over);
		if (initOver) result.init = { ...TEAM_INIT, ...initOver };
		try {
			await readUsageItems(ctx, { readUsage: (async () => result) as never });
		} catch (error) {
			return error as { message: string; description: string };
		}
		assert.fail('expected a rejection');
	};

	it('an unauthenticated CLI — the one that looks like success', async () => {
		const error = await failFor(
			{ usage: withoutLimits },
			{ account: { ...TEAM_INIT.account, tokenSource: 'none' } },
		);
		assert.match(error.description, /has no login/);
	});

	it('an inference-only token names the probe as the way out', async () => {
		const error = await failFor(
			{ usage: { ...withoutLimits, subscription_type: null } },
			{ account: { ...TEAM_INIT.account, tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' } },
		);
		assert.match(error.description, /inference-only by design/);
	});

	it('an API-key session is told plan limits simply do not apply', async () => {
		const error = await failFor({
			usage: { ...withoutLimits, subscription_type: null },
		});
		assert.match(error.description, /billed per token/);
	});

	it('does not throw when the limits are there', async () => {
		const { items } = await runUsage({
			queue: [read()],
			params: { usageOptions: { errorIfLimitsUnavailable: true } },
		});
		assert.equal(items.length, 1);
	});
});

describe('ClaudeCodeUsage.execute — the adapter', () => {
	it('exposes execute and the description', () => {
		const node = new ClaudeCodeUsage();
		assert.equal(typeof node.execute, 'function');
		assert.equal(node.description.name, 'claudeCodeUsage');
	});

	it('validates the project path before reaching the real CLI', async () => {
		const { ctx } = createFakeContext({
			params: usageParams({ projectPath: '/definitely/not/here' }),
		});
		await assert.rejects(
			() => new ClaudeCodeUsage().execute.call(ctx),
			/Project Path is not an existing directory/,
		);
	});
});
