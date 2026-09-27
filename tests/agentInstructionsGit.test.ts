import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
	loadInstructions,
	MAX_INSTRUCTIONS_FILE_BYTES,
	readInstructions,
} from '../nodes/ClaudeCodeAgent/instructions';
import { createRefReader, type RefReader } from '../nodes/shared/git';

/**
 * Read Instruction Files From Ref against a REAL repository: two commits where the rules differ,
 * and a file that exists only on the later one. Every other test of this feature fakes git.
 */

const hasGit = (() => {
	try {
		execFileSync('git', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: os.devNull,
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'Test',
	GIT_AUTHOR_EMAIL: 'test@example.com',
	GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
	GIT_COMMITTER_NAME: 'Test',
	GIT_COMMITTER_EMAIL: 'test@example.com',
	GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
};

let base: string;
let repo: string;

const git = (...args: string[]) =>
	execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, env: GIT_ENV });

const write = (rel: string, content: string) => {
	fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
	fs.writeFileSync(path.join(repo, rel), content);
};

/** The real reader, counting how often git was opened. */
const counting = () => {
	const opened: string[] = [];
	const openRef = (projectPath: string): RefReader => {
		opened.push(projectPath);
		return createRefReader(projectPath);
	};
	return { opened, openRef };
};

const at = (ref: string, files: string[], projectPath = repo) =>
	loadInstructions(projectPath, files, ref, counting().openRef);

describe('Instruction Files read at a git ref — a real repository', { skip: !hasGit }, () => {
	before(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-instructions-git-'));
		repo = path.join(base, 'repo');
		fs.mkdirSync(repo);
		git('init', '-q');
		write('.review/rules.md', 'Base rules.');
		write('sub/local.md', 'Sub base.');
		write('docs/a.md', 'A doc.');
		write('big.md', 'x'.repeat(MAX_INSTRUCTIONS_FILE_BYTES + 1));
		fs.symlinkSync('.review/rules.md', path.join(repo, 'link.md'));
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		git('tag', 'base');
		write('.review/rules.md', 'Head rules: flag everything.');
		write('.review/only-head.md', 'Only on head.');
		git('add', '-A');
		git('commit', '-q', '-m', 'head');
		write('.review/rules.md', 'Working tree rules.');
	});

	after(() => {
		fs.rmSync(base, { recursive: true, force: true });
	});

	it('reads the base content at the base ref and names the ref', async () => {
		assert.deepEqual(await at('base', ['.review/rules.md']), {
			append: '<instructions file=".review/rules.md">\nBase rules.\n</instructions>',
			loaded: ['.review/rules.md'],
			missing: [],
			ref: 'base',
		});
	});

	it('reads the head content at HEAD, not the uncommitted working tree', async () => {
		const r = await at('HEAD', ['.review/rules.md', '.review/only-head.md']);
		assert.ok(!('problem' in r));
		assert.equal(
			r.append,
			'<instructions file=".review/rules.md">\nHead rules: flag everything.\n</instructions>\n\n' +
				'<instructions file=".review/only-head.md">\nOnly on head.\n</instructions>',
		);
	});

	it('lists a file present only on head as missing when reading from base', async () => {
		const r = await at('base', ['.review/rules.md', '.review/only-head.md']);
		assert.ok(!('problem' in r));
		assert.deepEqual(r.loaded, ['.review/rules.md']);
		assert.deepEqual(r.missing, ['.review/only-head.md']);
	});

	it('resolves paths from a Project Path below the repository root', async () => {
		const r = await at('base', ['local.md', './local.md'], path.join(repo, 'sub'));
		assert.ok(!('problem' in r));
		assert.deepEqual(r.loaded, ['local.md', './local.md']);
		assert.match(String(r.append), /Sub base\./);
	});

	it('refuses "..", and absolute paths, without opening git', async () => {
		for (const entry of ['../outside.md', 'sub/../../x.md', '/etc/passwd']) {
			const { opened, openRef } = counting();
			const r = await loadInstructions(repo, [entry], 'base', openRef);
			assert.ok('problem' in r, entry);
			assert.match(r.problem.message, /resolves outside the Project Path/);
			assert.deepEqual(opened, [], entry);
		}
	});

	it('refuses a file over the cap', async () => {
		const r = await at('base', ['big.md']);
		assert.ok('problem' in r);
		assert.match(r.problem.message, /over the 256 KB limit/);
	});

	it('refuses a directory, a directory with a trailing slash, and a symbolic link', async () => {
		for (const entry of ['docs', 'docs/', 'link.md']) {
			const r = await at('base', [entry]);
			assert.ok('problem' in r, entry);
			assert.match(r.problem.message, /is not a file at base/, entry);
		}
	});

	it('refuses an option-looking ref or a range before spawning git', async () => {
		for (const ref of ['-x', '--output=/tmp/x', 'a..b', 'HEAD:secret']) {
			const { opened, openRef } = counting();
			const r = await loadInstructions(repo, ['.review/rules.md'], ref, openRef);
			assert.ok('problem' in r, ref);
			assert.match(r.problem.message, /^Read Instruction Files From Ref /, ref);
			assert.deepEqual(opened, [], ref);
		}
	});

	it('explains a ref the clone does not have, and how to fix it', async () => {
		const r = await at('origin/nosuch', ['.review/rules.md']);
		assert.ok('problem' in r);
		assert.match(r.problem.message, /could not be read at origin\/nosuch/);
		assert.match(String(r.problem.description), /does not exist in this clone\. Fetch it first/);
	});

	it('with no ref reads the working tree exactly as before', async () => {
		const { opened, openRef } = counting();
		const files = ['.review/rules.md', '.review/only-head.md', 'nope.md'];
		const r = await loadInstructions(repo, files, '', openRef);
		assert.deepEqual(r, readInstructions(repo, files));
		assert.ok(!('problem' in r));
		assert.equal(r.ref, undefined);
		assert.ok(!('ref' in r));
		assert.match(String(r.append), /Working tree rules\./);
		assert.deepEqual(opened, []);
	});
});
