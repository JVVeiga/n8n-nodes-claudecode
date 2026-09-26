import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
	fingerprint,
	fingerprintItems,
	normalizeSnippet,
	splitLines,
	type FileRead,
} from '../nodes/CodeReviewKit/fingerprint';

const FILE = [
	'function add(a, b) {',
	'    const sum   =  a + b;',
	'',
	'    return sum;',
	'}',
	'',
].join('\n');

const FIELDS = { path: 'path', line: 'line', type: 'type', fingerprint: 'fingerprint' };

const reader =
	(files: Record<string, string>, calls: string[] = []) =>
	async (path: string): Promise<FileRead> => {
		calls.push(path);
		return path in files ? { text: files[path] } : { error: `${path} does not exist at HEAD` };
	};

describe('Code Review Kit — normalizeSnippet', () => {
	const lines = splitLines(FILE);

	it('does not count the final newline as a line', () => {
		assert.equal(lines.length, 5);
	});

	it('takes the anchor ± radius, trimmed, collapsed, blank lines dropped', () => {
		assert.equal(normalizeSnippet(lines, 2, 1), 'function add(a, b) {\nconst sum = a + b;');
		assert.equal(normalizeSnippet(lines, 4, 1), 'return sum;\n}');
	});

	it('clamps at both file edges', () => {
		assert.equal(normalizeSnippet(lines, 1, 10), normalizeSnippet(lines, 5, 10));
		assert.equal(normalizeSnippet(lines, 1, 0), 'function add(a, b) {');
	});

	it('returns null for a line outside the file', () => {
		assert.equal(normalizeSnippet(lines, 0, 2), null);
		assert.equal(normalizeSnippet(lines, 6, 2), null);
	});

	it('ignores carriage returns and indentation changes', () => {
		const crlf = splitLines(FILE.replace(/\n/g, '\r\n'));
		const reindented = splitLines(FILE.replace(/ {4}/g, '\t\t'));
		assert.equal(normalizeSnippet(crlf, 2, 2), normalizeSnippet(lines, 2, 2));
		assert.equal(normalizeSnippet(reindented, 2, 2), normalizeSnippet(lines, 2, 2));
	});
});

describe('Code Review Kit — fingerprint', () => {
	it('is sha256 of path NUL type NUL snippet', () => {
		const expected = createHash('sha256').update('a.ts\0bug\0x = 1').digest('hex');
		assert.equal(fingerprint('a.ts', 'bug', 'x = 1'), expected);
	});

	it('is stable when lines are inserted above the snippet', () => {
		const before = splitLines(FILE);
		const after = splitLines(`// header\nimport x from 'y';\n\n${FILE}`);
		const a = fingerprint('m.js', 'bug', normalizeSnippet(before, 2, 2) as string);
		const b = fingerprint('m.js', 'bug', normalizeSnippet(after, 5, 2) as string);
		assert.equal(a, b);
	});

	it('changes when the snippet text, the type or the path changes', () => {
		const lines = splitLines(FILE);
		const edited = splitLines(FILE.replace('a + b', 'a - b'));
		const base = fingerprint('m.js', 'bug', normalizeSnippet(lines, 2, 2) as string);
		assert.notEqual(base, fingerprint('m.js', 'bug', normalizeSnippet(edited, 2, 2) as string));
		assert.notEqual(base, fingerprint('m.js', 'style', normalizeSnippet(lines, 2, 2) as string));
		assert.notEqual(base, fingerprint('n.js', 'bug', normalizeSnippet(lines, 2, 2) as string));
	});
});

describe('Code Review Kit — fingerprintItems', () => {
	it('adds the fingerprint, reads each file once, and keeps every item in place', async () => {
		const calls: string[] = [];
		const items = [
			{ path: 'm.js', line: 2, type: 'bug' },
			{ path: 'gone.js', line: 1, type: 'bug' },
			{ path: 'm.js', line: 99, type: 'bug' },
			{ path: 'm.js', line: 'two' },
			42,
			{ path: 'm.js', line: 4 },
		];
		const out = (await fingerprintItems(
			items,
			FIELDS,
			2,
			reader({ 'm.js': FILE }, calls),
		)) as Array<Record<string, unknown>>;

		assert.equal(out.length, items.length);
		assert.deepEqual(calls, ['m.js', 'gone.js']);
		assert.equal(
			out[0].fingerprint,
			fingerprint('m.js', 'bug', normalizeSnippet(splitLines(FILE), 2, 2) as string),
		);
		assert.deepEqual(out[1], {
			path: 'gone.js',
			line: 1,
			type: 'bug',
			fingerprint: null,
			error: 'gone.js does not exist at HEAD',
		});
		assert.equal(out[2].fingerprint, null);
		assert.equal(out[2].error, 'line 99 is outside m.js (5 lines)');
		assert.equal(out[3].error, '"line" must be a positive integer');
		assert.deepEqual(out[4], { value: 42, fingerprint: null, error: 'item is not an object' });
		// A missing type hashes as the empty string.
		assert.equal(
			out[5].fingerprint,
			fingerprint('m.js', '', normalizeSnippet(splitLines(FILE), 4, 2) as string),
		);
	});

	it('writes to the configured fields', async () => {
		const out = (await fingerprintItems(
			[{ file: 'm.js', at: 2, kind: 'bug' }],
			{ path: 'file', line: 'at', type: 'kind', fingerprint: 'fp' },
			0,
			reader({ 'm.js': FILE }),
		)) as Array<Record<string, unknown>>;
		assert.equal(out[0].fp, fingerprint('m.js', 'bug', 'const sum = a + b;'));
		assert.equal('fingerprint' in out[0], false);
	});
});
