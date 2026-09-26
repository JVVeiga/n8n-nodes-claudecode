import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { NodeOperationError, type INodeProperties } from 'n8n-workflow';
import { runKitItems } from '../nodes/CodeReviewKit/CodeReviewKit.node';
import { codeReviewKitDescription } from '../nodes/CodeReviewKit/description';
import type { GitApi, GitResult } from '../nodes/CodeReviewKit/git';
import { createFakeContext, type ParamMap } from './helpers/executeFunctions';

const REPO = process.cwd();
const MERGE_BASE = '1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c';

const NUMSTAT =
	':100644 100644 01f84f8 f29fd59 M\0src/app.ts\0' +
	':000000 100644 0000000 5804e55 A\0src/new.ts\0' +
	'3\t0\tsrc/app.ts\0' +
	'2\t0\tsrc/new.ts\0';

const PATCH = [
	'diff --git a/src/app.ts b/src/app.ts',
	'--- a/src/app.ts',
	'+++ b/src/app.ts',
	'@@ -1,0 +2 @@ l1',
	'+NEW2',
	'@@ -7,0 +9,2 @@ l7',
	'+NEW9a',
	'+NEW9b',
	'diff --git a/src/new.ts b/src/new.ts',
	'--- /dev/null',
	'+++ b/src/new.ts',
	'@@ -0,0 +1,2 @@',
	'+n1',
	'+n2',
	'',
].join('\n');

const APP = ['l1', 'NEW2', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'NEW9a', 'NEW9b', 'l8', ''].join(
	'\n',
);

type GitCall = [string, ...string[]];

function fakeGit(overrides: Partial<Record<keyof GitApi, (...a: string[]) => GitResult>> = {}) {
	const calls: GitCall[] = [];
	const paths: string[] = [];
	const answer =
		(name: keyof GitApi, fallback: (...a: string[]) => GitResult) =>
		async (...args: string[]) => {
			calls.push([name, ...args]);
			return (overrides[name] ?? fallback)(...args);
		};
	const factory = (projectPath: string): GitApi => {
		paths.push(projectPath);
		return {
			mergeBase: answer('mergeBase', () => ({ ok: MERGE_BASE })),
			numstat: answer('numstat', () => ({ ok: NUMSTAT })),
			patchU0: answer('patchU0', () => ({ ok: PATCH })),
			showFile: answer('showFile', (_ref, path) =>
				path === 'src/app.ts'
					? { ok: APP }
					: { problem: { message: `${path} does not exist at HEAD` }, missing: true },
			),
		};
	};
	return { calls, paths, factory };
}

const run = async (params: ParamMap, opts: { continueOnFail?: boolean; items?: number } = {}) => {
	const git = fakeGit();
	const fake = createFakeContext({
		params,
		nodeName: 'Code Review Kit',
		continueOnFail: opts.continueOnFail,
		items: Array.from({ length: opts.items ?? 1 }, () => ({ json: {} })),
	});
	return { git, fake, run: () => runKitItems(fake.ctx, { git: git.factory }) };
};

const diffParams = (over: ParamMap = {}): ParamMap => ({
	operation: 'diffContext',
	projectPath: REPO,
	baseRef: 'origin/main',
	headRef: 'HEAD',
	includePatch: false,
	...over,
});

describe('Code Review Kit node — Diff Context', () => {
	it('diffs from the merge base and reports files and added lines', async () => {
		const t = await run(diffParams());
		const [[item]] = await t.run();
		assert.deepEqual(t.git.paths, [REPO]);
		assert.deepEqual(t.git.calls, [
			['mergeBase', 'origin/main', 'HEAD'],
			['numstat', MERGE_BASE, 'HEAD'],
			['patchU0', MERGE_BASE, 'HEAD'],
		]);
		assert.deepEqual(item.json, {
			mergeBase: MERGE_BASE,
			files: [
				{ path: 'src/app.ts', status: 'modified', additions: 3, deletions: 0 },
				{ path: 'src/new.ts', status: 'added', additions: 2, deletions: 0 },
			],
			addedLines: { 'src/app.ts': [2, 9, 10], 'src/new.ts': [1, 2] },
		});
		assert.deepEqual(item.pairedItem, { item: 0 });
	});

	it('adds the patch, truncated to the cap, when asked', async () => {
		const t = await run(diffParams({ includePatch: true, maxPatchChars: 60 }));
		const [[item]] = await t.run();
		assert.equal(item.json.patchTruncated, true);
		assert.match(item.json.patch as string, /\[patch truncated: \d+ of \d+ characters\]\n$/);
	});

	it('refuses a bad ref before any git call', async () => {
		for (const over of [
			{ baseRef: 'main; rm -rf /' },
			{ headRef: '--output=/tmp/x' },
			{ baseRef: '' },
		]) {
			const t = await run(diffParams(over));
			await assert.rejects(t.run(), (error: unknown) => {
				assert.ok(error instanceof NodeOperationError);
				assert.match(error.message, /Ref (is empty|is not an accepted git ref)/);
				assert.ok(error.description);
				return true;
			});
			assert.deepEqual(t.git.paths, []);
			assert.deepEqual(t.git.calls, []);
		}
	});

	it('needs an existing Project Path, before any git call', async () => {
		for (const projectPath of ['', '/definitely/not/here']) {
			const t = await run(diffParams({ projectPath }));
			await assert.rejects(t.run(), NodeOperationError);
			assert.deepEqual(t.git.paths, []);
		}
	});

	it('surfaces a git failure with its fix', async () => {
		const git = fakeGit({
			mergeBase: () => ({
				problem: { message: 'git merge-base failed: fatal: bad', description: 'Fetch it first.' },
			}),
		});
		const fake = createFakeContext({ params: diffParams() });
		await assert.rejects(runKitItems(fake.ctx, { git: git.factory }), (error: unknown) => {
			assert.ok(error instanceof NodeOperationError);
			assert.equal(error.message, 'git merge-base failed: fatal: bad');
			assert.equal(error.description, 'Fetch it first.');
			return true;
		});
	});
});

describe('Code Review Kit node — Validate Anchors', () => {
	const findings = [
		{ path: 'src/app.ts', line: 9, body: 'on an added line' },
		{ path: 'src/app.ts', line: 3, body: 'on an unchanged line' },
	];
	const added = { 'src/app.ts': [2, 9, 10] };
	const expected = {
		valid: [findings[0]],
		moved: [{ item: findings[1], reason: 'line 3 is not an added line in src/app.ts' }],
	};

	it('accepts the JSON parameters as text', async () => {
		const t = await run({
			operation: 'validateAnchors',
			items: JSON.stringify(findings),
			addedLines: JSON.stringify(added),
		});
		const [[item]] = await t.run();
		assert.deepEqual(item.json, expected);
		assert.deepEqual(t.git.paths, []);
	});

	it('accepts the JSON parameters already parsed by an expression', async () => {
		const t = await run({ operation: 'validateAnchors', items: findings, addedLines: added });
		const [[item]] = await t.run();
		assert.deepEqual(item.json, expected);
	});

	it('reads the configured field names', async () => {
		const t = await run({
			operation: 'validateAnchors',
			items: [{ file: 'src/app.ts', at: 10 }],
			addedLines: added,
			pathField: 'file',
			lineField: 'at',
		});
		const [[item]] = await t.run();
		assert.deepEqual(item.json.valid, [{ file: 'src/app.ts', at: 10 }]);
	});

	it('fails on JSON that does not parse, or is the wrong shape, with the fix', async () => {
		const cases: Array<[ParamMap, RegExp]> = [
			[{ items: '[{', addedLines: added }, /^Items is not valid JSON/],
			[{ items: { path: 'x' }, addedLines: added }, /^Items must be a JSON array, got object/],
			[{ items: findings, addedLines: { 'a.ts': 3 } }, /^Added Lines must map each file path/],
		];
		for (const [params, message] of cases) {
			const t = await run({ operation: 'validateAnchors', ...params });
			await assert.rejects(t.run(), (error: unknown) => {
				assert.ok(error instanceof NodeOperationError);
				assert.match(error.message, message);
				assert.match(error.description ?? '', /^Pass /);
				return true;
			});
		}
	});
});

describe('Code Review Kit node — Fingerprint', () => {
	const params = (over: ParamMap = {}): ParamMap => ({
		operation: 'fingerprint',
		projectPath: REPO,
		ref: 'HEAD',
		items: [
			{ path: 'src/app.ts', line: 9, type: 'bug' },
			{ path: 'src/gone.ts', line: 1, type: 'bug' },
		],
		contextLines: 1,
		...over,
	});

	it('reads each file at the ref and adds the fingerprint, never dropping an item', async () => {
		const t = await run(params());
		const [[item]] = await t.run();
		const out = item.json.items as Array<Record<string, unknown>>;
		assert.equal(out.length, 2);
		assert.match(out[0].fingerprint as string, /^[0-9a-f]{64}$/);
		assert.deepEqual(out[1], {
			path: 'src/gone.ts',
			line: 1,
			type: 'bug',
			fingerprint: null,
			error: 'src/gone.ts does not exist at HEAD',
		});
		assert.deepEqual(t.git.calls, [
			['showFile', 'HEAD', 'src/app.ts'],
			['showFile', 'HEAD', 'src/gone.ts'],
		]);
	});

	it('gives the same fingerprint for the same snippet at another line', async () => {
		const shifted = `top\nmore\n${APP}`;
		const at = async (file: string, line: number) => {
			const git = fakeGit({ showFile: () => ({ ok: file }) });
			const fake = createFakeContext({
				params: params({ items: [{ path: 'src/app.ts', line, type: 'bug' }] }),
			});
			const [[item]] = await runKitItems(fake.ctx, { git: git.factory });
			return (item.json.items as Array<Record<string, unknown>>)[0].fingerprint;
		};
		assert.equal(await at(APP, 9), await at(shifted, 11));
		assert.notEqual(await at(APP, 9), await at(APP.replace('NEW9a', 'EDITED'), 9));
	});

	it('writes to the configured fingerprint field and reads the configured type', async () => {
		const t = await run(
			params({
				items: [{ file: 'src/app.ts', at: 2, kind: 'style' }],
				pathField: 'file',
				lineField: 'at',
				typeField: 'kind',
				fingerprintField: 'fp',
			}),
		);
		const [[item]] = await t.run();
		const [out] = item.json.items as Array<Record<string, unknown>>;
		assert.match(out.fp as string, /^[0-9a-f]{64}$/);
	});

	it('fails the run when git itself fails, and refuses a bad ref before git', async () => {
		const git = fakeGit({
			showFile: () => ({
				problem: { message: 'git ls-tree failed: fatal: Not a valid object name x' },
			}),
		});
		const fake = createFakeContext({ params: params() });
		await assert.rejects(runKitItems(fake.ctx, { git: git.factory }), /Not a valid object name/);

		const t = await run(params({ ref: 'HEAD:src/app.ts' }));
		await assert.rejects(t.run(), /Ref is not an accepted git ref/);
		assert.deepEqual(t.git.paths, []);
	});
});

describe('Code Review Kit node — Dedupe', () => {
	it('splits into new, repeated and resolved', async () => {
		const t = await run({
			operation: 'dedupe',
			newItems: JSON.stringify([{ fingerprint: 'a' }, { fingerprint: 'b' }]),
			previousItems: [
				{ fingerprint: 'a', status: 'open', id: 1 },
				{ fingerprint: 'c', status: 'open', id: 2 },
			],
		});
		const [[item]] = await t.run();
		assert.deepEqual(item.json, {
			new: [{ fingerprint: 'b' }],
			repeated: [
				{ item: { fingerprint: 'a' }, previous: { fingerprint: 'a', status: 'open', id: 1 } },
			],
			resolved: [{ fingerprint: 'c', status: 'open', id: 2 }],
		});
	});

	it('reads the configured fields and open value, and falls back when one is emptied', async () => {
		const t = await run({
			operation: 'dedupe',
			newItems: [],
			previousItems: [
				{ fp: 'z', state: 'OPEN' },
				{ fp: 'y', state: 'open' },
			],
			fingerprintField: 'fp',
			statusField: 'state',
			openValue: 'OPEN',
		});
		const [[item]] = await t.run();
		assert.deepEqual(item.json.resolved, [{ fp: 'z', state: 'OPEN' }]);

		const fallback = await run({
			operation: 'dedupe',
			newItems: [],
			previousItems: [{ fingerprint: 'q', status: 'open' }],
			fingerprintField: '  ',
			openValue: '',
		});
		const [[back]] = await fallback.run();
		assert.equal((back.json.resolved as unknown[]).length, 1);
	});
});

describe('Code Review Kit node — continueOnFail', () => {
	it('turns a failed item into an error item and carries on', async () => {
		const t = await run(
			diffParams({ baseRef: (i: number) => (i === 0 ? 'bad ref' : 'origin/main') }),
			{ continueOnFail: true, items: 2 },
		);
		const [out] = await t.run();
		assert.equal(out.length, 2);
		assert.match(out[0].json.error as string, /^Base Ref is not an accepted git ref/);
		assert.ok(out[0].json.description);
		assert.deepEqual(out[0].pairedItem, { item: 0 });
		assert.equal(out[1].json.mergeBase, MERGE_BASE);
		assert.deepEqual(out[1].pairedItem, { item: 1 });
	});

	it('catches a parameter that fails to resolve', async () => {
		const t = await run(
			{
				operation: 'dedupe',
				newItems: () => {
					throw new Error('Referenced node is unexecuted');
				},
				previousItems: [],
			},
			{ continueOnFail: true },
		);
		const [[item]] = await t.run();
		assert.deepEqual(item.json, { error: 'Referenced node is unexecuted' });
	});
});

describe('Code Review Kit — description', () => {
	const d = codeReviewKitDescription;
	const property = (name: string) => d.properties.find((p) => p.name === name);

	it('is a version-1 main node named codeReviewKit, not usable as a tool, with no credentials', () => {
		assert.equal(d.name, 'codeReviewKit');
		assert.equal(d.displayName, 'Code Review Kit');
		assert.equal(d.version, 1);
		assert.equal(d.usableAsTool, undefined);
		assert.equal(d.credentials, undefined);
		assert.deepEqual(d.inputs, [{ type: 'main' }]);
		assert.deepEqual(d.outputs, [{ type: 'main' }]);
	});

	it('offers the four operations in alphabetical order', () => {
		const options = (property('operation')?.options ?? []) as Array<{
			name: string;
			value: string;
		}>;
		assert.deepEqual(
			options.map((o) => [o.name, o.value]),
			[
				['Dedupe', 'dedupe'],
				['Diff Context', 'diffContext'],
				['Fingerprint', 'fingerprint'],
				['Validate Anchors', 'validateAnchors'],
			],
		);
		assert.equal(property('operation')?.default, 'diffContext');
	});

	it('defaults the field names and refs as documented', () => {
		const defaults = Object.fromEntries(
			(d.properties as INodeProperties[]).map((p) => [p.name, p.default]),
		);
		assert.deepEqual(
			{
				headRef: defaults.headRef,
				ref: defaults.ref,
				pathField: defaults.pathField,
				lineField: defaults.lineField,
				typeField: defaults.typeField,
				fingerprintField: defaults.fingerprintField,
				statusField: defaults.statusField,
				openValue: defaults.openValue,
				contextLines: defaults.contextLines,
			},
			{
				headRef: 'HEAD',
				ref: 'HEAD',
				pathField: 'path',
				lineField: 'line',
				typeField: 'type',
				fingerprintField: 'fingerprint',
				statusField: 'status',
				openValue: 'open',
				contextLines: 2,
			},
		);
	});

	it('only params.ts calls getNodeParameter', () => {
		const dir = join(process.cwd(), 'nodes', 'CodeReviewKit');
		const readers = (readdirSync(dir) as string[])
			.filter((f) => f.endsWith('.ts'))
			.filter((f) => /\.getNodeParameter\(/.test(readFileSync(join(dir, f), 'utf8')));
		assert.deepEqual(readers, ['params.ts']);
	});

	it('is registered in package.json with its codex and icon', () => {
		const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
		assert.ok(pkg.n8n.nodes.includes('dist/nodes/CodeReviewKit/CodeReviewKit.node.js'));
		const codex = JSON.parse(
			readFileSync(join(process.cwd(), 'nodes/CodeReviewKit/CodeReviewKit.node.json'), 'utf8'),
		);
		assert.equal(codex.node, '@joaoveiga/n8n-nodes-claudecode.codeReviewKit');
		assert.ok(existsSync(join(process.cwd(), 'nodes/CodeReviewKit/claudecode.svg')));
		assert.equal(d.icon, 'file:claudecode.svg');
	});
});
