import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	createGit,
	GIT_MAX_BUFFER,
	GIT_TIMEOUT_MS,
	type ExecFailure,
	type ExecFileFn,
	type ExecOptions,
} from '../nodes/CodeReviewKit/git';
import { checkRef, isSafeRef } from '../nodes/CodeReviewKit/refs';

type Call = { file: string; args: string[]; options: ExecOptions };

const recorder = (respond: (args: string[]) => string | ExecFailure = () => '') => {
	const calls: Call[] = [];
	const exec: ExecFileFn = async (file, args, options) => {
		calls.push({ file, args, options });
		const out = respond(args);
		if (typeof out !== 'string') throw out;
		return { stdout: out };
	};
	return { calls, exec };
};

const failure = (props: Partial<ExecFailure>): ExecFailure =>
	Object.assign(new Error('Command failed'), props);

const GLOBAL = ['-c', 'core.quotePath=false', '--literal-pathspecs'];
const SHA = 'cc36390c6ee19d5b14ec24a6b1fc04687657eb22';

describe('Code Review Kit — refs', () => {
	it('accepts branches, tags, SHAs and relative refs', () => {
		for (const ref of [
			'main',
			'origin/main',
			'v1.2.0',
			'HEAD~1',
			'HEAD^2',
			'a1b2c3',
			'user@feature_x',
		]) {
			assert.equal(isSafeRef(ref), true, ref);
		}
	});

	it('refuses option-looking, spaced, colon and shell refs', () => {
		for (const ref of [
			'-p',
			'--output=/tmp/x',
			'main; rm -rf /',
			'a b',
			'HEAD:file',
			'$(id)',
			'`x`',
			'a|b',
		]) {
			assert.equal(isSafeRef(ref), false, ref);
		}
	});

	it('names the parameter and the fix', () => {
		const problem = checkRef('--output=x', 'Base Ref');
		assert.match(problem?.message ?? '', /^Base Ref is not an accepted git ref/);
		assert.match(problem?.description ?? '', /not starting with "-"/);
		assert.equal(checkRef('', 'Head Ref')?.message, 'Head Ref is empty');
	});
});

describe('Code Review Kit — git.ts runs git with an argument array', () => {
	it('passes cwd, a timeout and a maxBuffer, and never a shell', async () => {
		const { calls, exec } = recorder(() => `${SHA}\n`);
		const result = await createGit('/repo', exec).mergeBase('origin/main', 'HEAD');
		assert.deepEqual(result, { ok: SHA });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].file, 'git');
		assert.deepEqual(calls[0].args, [...GLOBAL, 'merge-base', 'origin/main', 'HEAD']);
		assert.equal(calls[0].options.cwd, '/repo');
		assert.equal(calls[0].options.timeout, GIT_TIMEOUT_MS);
		assert.equal(calls[0].options.maxBuffer, GIT_MAX_BUFFER);
		assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
		assert.equal(calls[0].options.env.LC_ALL, 'C', 'messages the failure mapping can match');
		assert.equal('shell' in calls[0].options, false);
	});

	it('asks for exactly the diff formats the parsers read', async () => {
		const { calls, exec } = recorder();
		const git = createGit('/repo', exec);
		await git.numstat('abc', 'HEAD');
		await git.patchU0('abc', 'HEAD');
		const flags = [
			'--no-color',
			'--no-ext-diff',
			'--no-textconv',
			'--find-renames',
			'--no-relative',
		];
		assert.deepEqual(calls[0].args, [
			...GLOBAL,
			'diff',
			'--raw',
			'--numstat',
			'-z',
			...flags,
			'abc',
			'HEAD',
			'--',
		]);
		assert.deepEqual(calls[1].args, [
			...GLOBAL,
			'diff',
			'-U0',
			...flags,
			'--src-prefix=a/',
			'--dst-prefix=b/',
			'abc',
			'HEAD',
			'--',
		]);
	});

	it('reads a file through ls-tree with the path after --, then cat-file by blob id', async () => {
		const { calls, exec } = recorder((args) =>
			args.includes('ls-tree') ? `100644 blob ${SHA}\t-rf weird.txt\0` : 'content\n',
		);
		const result = await createGit('/repo', exec).showFile('HEAD', '-rf weird.txt');
		assert.deepEqual(result, { ok: 'content\n' });
		assert.deepEqual(calls[0].args, [
			...GLOBAL,
			'ls-tree',
			'-z',
			'--full-tree',
			'HEAD',
			'--',
			'-rf weird.txt',
		]);
		assert.deepEqual(calls[1].args, [...GLOBAL, 'cat-file', 'blob', SHA]);
	});

	it('reports a path absent at the ref, or a directory, as missing', async () => {
		const absent = await createGit('/repo', recorder(() => '').exec).showFile('HEAD', 'x.ts');
		assert.deepEqual(absent, {
			problem: { message: 'x.ts does not exist at HEAD' },
			missing: true,
		});
		const dir = await createGit('/repo', recorder(() => `040000 tree ${SHA}\tsrc\0`).exec).showFile(
			'HEAD',
			'src',
		);
		assert.deepEqual(dir, { problem: { message: 'src is not a file at HEAD' }, missing: true });
	});

	it('refuses a bad ref before spawning anything', async () => {
		const { calls, exec } = recorder();
		const git = createGit('/repo', exec);
		const results = [
			await git.mergeBase('--output=/tmp/x', 'HEAD'),
			await git.numstat('abc', 'HEAD; id'),
			await git.patchU0('a b', 'HEAD'),
			await git.showFile('HEAD:secret', 'x.ts'),
		];
		assert.equal(calls.length, 0);
		for (const result of results) assert.ok('problem' in result);
	});

	it('turns git failures into a problem carrying stderr and the fix', async () => {
		const notRepo = await createGit(
			'/tmp',
			recorder(() =>
				failure({
					code: 128,
					stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
				}),
			).exec,
		).mergeBase('main', 'HEAD');
		assert.deepEqual(notRepo, {
			problem: {
				message:
					'git merge-base failed: fatal: not a git repository (or any of the parent directories): .git',
				description:
					'Project Path must be a directory inside a git repository (a clone, with its .git).',
			},
		});

		const unknown = await createGit(
			'/repo',
			recorder(() => failure({ code: 128, stderr: 'fatal: Not a valid object name nosuch\n' }))
				.exec,
		).mergeBase('nosuch', 'HEAD');
		assert.match(('problem' in unknown && unknown.problem.description) || '', /Fetch it first/);

		const noGit = await createGit(
			'/repo',
			recorder(() => failure({ code: 'ENOENT' })).exec,
		).numstat('a', 'b');
		assert.match(('problem' in noGit && noGit.problem.description) || '', /git is not installed/);

		const slow = await createGit(
			'/repo',
			recorder(() => failure({ killed: true, signal: 'SIGTERM' })).exec,
		).patchU0('a', 'b');
		assert.match(
			('problem' in slow && slow.problem.description) || '',
			/did not finish within 60s/,
		);
	});

	it('a diff over the output limit says so and how to narrow it, not that git was slow', async () => {
		const overflow = () =>
			failure({
				code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
				killed: true,
				signal: 'SIGTERM',
				message: 'stdout maxBuffer length exceeded',
			});
		const git = createGit('/repo', recorder(overflow).exec);
		for (const result of [await git.numstat('a', 'b'), await git.patchU0('a', 'b')]) {
			assert.ok('problem' in result);
			assert.equal(result.problem.message, 'git diff output is larger than 64 MB');
			assert.match(result.problem.description ?? '', /too large/);
			assert.match(result.problem.description ?? '', /Base Ref/);
			assert.doesNotMatch(result.problem.description ?? '', /did not finish/);
		}
	});

	it('a file over the output limit fails only its own item', async () => {
		const { exec } = recorder((args) =>
			args.includes('ls-tree')
				? `100644 blob ${SHA}\tbig.bin\0`
				: failure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
		);
		const result = await createGit('/repo', exec).showFile('HEAD', 'big.bin');
		assert.deepEqual(result, {
			problem: { message: 'big.bin is larger than 64 MB at HEAD' },
			missing: true,
		});
	});

	it('says "no common ancestor" for merge-base exiting 1 with no stderr', async () => {
		const result = await createGit(
			'/repo',
			recorder(() => failure({ code: 1, stderr: '' })).exec,
		).mergeBase('orphan', 'HEAD');
		assert.equal(
			'problem' in result && result.problem.message,
			'orphan and HEAD have no common ancestor',
		);
	});
});

describe('Code Review Kit — only git.ts spawns, and never through a shell', () => {
	const dir = join(process.cwd(), 'nodes', 'CodeReviewKit');
	const sources = (readdirSync(dir) as string[])
		.filter((f) => f.endsWith('.ts'))
		.map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));

	it('no other module imports child_process', () => {
		const spawners = sources.filter((s) => /child_process/.test(s.text)).map((s) => s.file);
		assert.deepEqual(spawners, ['git.ts']);
	});

	it('git.ts uses execFile, never exec, execSync, spawn or a shell option', () => {
		const git = sources.find((s) => s.file === 'git.ts')?.text ?? '';
		assert.match(git, /import \{ execFile \} from 'node:child_process'/);
		assert.doesNotMatch(git, /(?<![.\w])exec(Sync)?\(|\bspawn(Sync)?\b|execFileSync|shell\s*:/);
	});
});
