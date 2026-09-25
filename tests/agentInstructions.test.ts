import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
	MAX_INSTRUCTIONS_FILE_BYTES,
	readInstructions,
} from '../nodes/ClaudeCodeAgent/instructions';

let base: string;
let repo: string;
let elsewhere: string;

before(() => {
	base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-instructions-'));
	repo = path.join(base, 'repo');
	elsewhere = path.join(base, 'elsewhere');
	fs.mkdirSync(path.join(repo, '.review'), { recursive: true });
	fs.mkdirSync(elsewhere);
	fs.writeFileSync(path.join(repo, '.review', 'review.md'), 'Review rules.');
	fs.writeFileSync(path.join(repo, 'STYLE.md'), 'Style rules.');
	fs.writeFileSync(path.join(elsewhere, 'secret.md'), 'not yours');
	fs.symlinkSync(path.join(elsewhere, 'secret.md'), path.join(repo, 'link.md'));
	fs.symlinkSync(path.join(repo, 'STYLE.md'), path.join(repo, 'style-link.md'));
	fs.writeFileSync(path.join(repo, 'big.md'), 'x'.repeat(MAX_INSTRUCTIONS_FILE_BYTES + 1));
	fs.writeFileSync(path.join(repo, 'exact.md'), 'y'.repeat(MAX_INSTRUCTIONS_FILE_BYTES));
});

after(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

const ok = (r: ReturnType<typeof readInstructions>) => {
	assert.ok(!('problem' in r), `unexpected problem: ${JSON.stringify(r)}`);
	return r;
};

const problem = (r: ReturnType<typeof readInstructions>) => {
	assert.ok('problem' in r, `expected a problem, got ${JSON.stringify(r)}`);
	return r.problem;
};

describe('readInstructions', () => {
	it('returns nothing for an empty list, without touching the disk', () => {
		assert.deepEqual(readInstructions('/does/not/exist', []), {
			append: undefined,
			loaded: [],
			missing: [],
		});
		assert.deepEqual(readInstructions('', ['  ', '']), {
			append: undefined,
			loaded: [],
			missing: [],
		});
	});

	it('wraps each file under a header naming it, in the order given', () => {
		const r = ok(readInstructions(repo, ['STYLE.md', ' .review/review.md ']));
		assert.deepEqual(r.loaded, ['STYLE.md', '.review/review.md']);
		assert.deepEqual(r.missing, []);
		assert.equal(
			r.append,
			'<instructions file="STYLE.md">\nStyle rules.\n</instructions>\n\n' +
				'<instructions file=".review/review.md">\nReview rules.\n</instructions>',
		);
	});

	it('lists a missing file and still loads the rest', () => {
		const r = ok(readInstructions(repo, ['.review/absent.md', 'STYLE.md', 'nope/x.md']));
		assert.deepEqual(r.loaded, ['STYLE.md']);
		assert.deepEqual(r.missing, ['.review/absent.md', 'nope/x.md']);
		assert.equal(r.append, '<instructions file="STYLE.md">\nStyle rules.\n</instructions>');
	});

	it('has no append when every file is missing', () => {
		const r = ok(readInstructions(repo, ['a.md', 'b.md']));
		assert.equal(r.append, undefined);
		assert.deepEqual(r.missing, ['a.md', 'b.md']);
	});

	it('refuses a ../ escape, naming the entry', () => {
		const p = problem(readInstructions(repo, ['STYLE.md', '../elsewhere/secret.md']));
		assert.match(p.message, /'\.\.\/elsewhere\/secret\.md' resolves outside the Project Path/);
	});

	it('refuses a ../ escape even when the target does not exist', () => {
		problem(readInstructions(repo, ['../nothing-here.md']));
	});

	it('refuses an absolute path outside the Project Path', () => {
		const target = path.join(elsewhere, 'secret.md');
		const p = problem(readInstructions(repo, [target]));
		assert.ok(p.message.includes(target));
	});

	it('accepts an absolute path inside the Project Path', () => {
		const r = ok(readInstructions(repo, [path.join(repo, 'STYLE.md')]));
		assert.deepEqual(r.loaded, [path.join(repo, 'STYLE.md')]);
	});

	it('refuses a symlink whose target escapes the Project Path', () => {
		const p = problem(readInstructions(repo, ['link.md']));
		assert.match(p.message, /'link\.md' resolves outside/);
	});

	it('follows a symlink that stays inside', () => {
		const r = ok(readInstructions(repo, ['style-link.md']));
		assert.match(r.append ?? '', /Style rules\./);
	});

	it('refuses a file over the cap, naming it and its size', () => {
		const p = problem(readInstructions(repo, ['big.md']));
		assert.match(p.message, /'big\.md'/);
		assert.ok(p.message.includes(String(MAX_INSTRUCTIONS_FILE_BYTES + 1)));
	});

	it('accepts a file exactly at the cap', () => {
		ok(readInstructions(repo, ['exact.md']));
	});

	it('refuses a directory', () => {
		assert.match(problem(readInstructions(repo, ['.review'])).message, /not a file/);
	});

	it('refuses Instruction Files without a Project Path', () => {
		assert.match(problem(readInstructions('', ['STYLE.md'])).message, /Project Path is empty/);
	});

	it('refuses a Project Path that does not exist', () => {
		assert.match(
			problem(readInstructions(path.join(base, 'gone'), ['STYLE.md'])).message,
			/does not exist/,
		);
	});
});
