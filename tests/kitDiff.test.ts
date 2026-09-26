import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	completeAddedLines,
	parseAddedLines,
	parseNumstat,
	truncatePatch,
	unquoteGitPath,
} from '../nodes/CodeReviewKit/diff';

// Recorded from `git -c core.quotePath=false diff --raw --numstat -z --find-renames --no-relative`
// across a commit that renames, modifies, adds, deletes and touches a binary file.
const NUMSTAT =
	':100644 100644 600d48a a3fb829 R086\0before.txt\0after.txt\0' +
	':100644 100644 01f84f8 f29fd59 M\0app.txt\0' +
	':100644 100644 1a9d148 b8520a8 M\0ação.txt\0' +
	':100644 100644 c1b0730 8352675 M\0bin.dat\0' +
	':000000 100644 0000000 5804e55 A\0new.txt\0' +
	':100644 000000 988cd72 0000000 D\0old.txt\0' +
	':100644 100644 fb3527e 34472d5 M\0with space.txt\0' +
	'1\t0\t\0before.txt\0after.txt\0' +
	'3\t0\tapp.txt\0' +
	'2\t1\tação.txt\0' +
	'-\t-\tbin.dat\0' +
	'3\t0\tnew.txt\0' +
	'0\t2\told.txt\0' +
	'1\t0\twith space.txt\0';

// The matching `git diff -U0 --src-prefix=a/ --dst-prefix=b/` output.
const PATCH = [
	'diff --git a/before.txt b/after.txt',
	'similarity index 86%',
	'rename from before.txt',
	'rename to after.txt',
	'index 600d48a..a3fb829 100644',
	'--- a/before.txt',
	'+++ b/after.txt',
	'@@ -5,0 +6 @@ epsilon',
	'+zeta',
	'diff --git a/app.txt b/app.txt',
	'index 01f84f8..f29fd59 100644',
	'--- a/app.txt',
	'+++ b/app.txt',
	'@@ -1,0 +2 @@ l1',
	'+NEW2',
	'@@ -7,0 +9,2 @@ l7',
	'+NEW9a',
	'+NEW9b',
	'diff --git a/ação.txt b/ação.txt',
	'index 1a9d148..b8520a8 100644',
	'--- a/ação.txt',
	'+++ b/ação.txt',
	'@@ -1 +1,2 @@',
	'-nonl',
	'\\ No newline at end of file',
	'+nonl',
	'+more',
	'\\ No newline at end of file',
	'diff --git a/bin.dat b/bin.dat',
	'index c1b0730..8352675 100644',
	'Binary files a/bin.dat and b/bin.dat differ',
	'diff --git a/new.txt b/new.txt',
	'new file mode 100644',
	'index 0000000..5804e55',
	'--- /dev/null',
	'+++ b/new.txt',
	'@@ -0,0 +1,3 @@',
	'+n1',
	'+n2',
	'+n3',
	'diff --git a/old.txt b/old.txt',
	'deleted file mode 100644',
	'index 988cd72..0000000',
	'--- a/old.txt',
	'+++ /dev/null',
	'@@ -1,2 +0,0 @@',
	'-gone1',
	'-gone2',
	'diff --git a/with space.txt b/with space.txt',
	'index fb3527e..34472d5 100644',
	'--- a/with space.txt\t',
	'+++ b/with space.txt\t',
	'@@ -1,0 +2 @@ sp1',
	'+sp2',
	'',
].join('\n');

// A second recording: deletion-only hunks, an added line whose text begins with "++", a quoted
// path and a rename of a name with a space.
const PATCH_EDGES = [
	'diff --git a/app.txt b/app.txt',
	'index f29fd59..cc36390 100644',
	'--- a/app.txt',
	'+++ b/app.txt',
	'@@ -2 +1,0 @@ l1',
	'-NEW2',
	'@@ -10 +8,0 @@ NEW9a',
	'-NEW9b',
	'diff --git a/plus.txt b/plus.txt',
	'index bf1a1fd..97e6ac1 100644',
	'--- a/plus.txt',
	'+++ b/plus.txt',
	'@@ -1,0 +2,2 @@ top',
	'+++ sneaky',
	'+-- also',
	'diff --git "a/we\\"ird\\tname.txt" "b/we\\"ird\\tname.txt"',
	'index bca70f3..92812c3 100644',
	'--- "a/we\\"ird\\tname.txt"',
	'+++ "b/we\\"ird\\tname.txt"',
	'@@ -1,0 +2 @@ q',
	'+q2',
	'diff --git a/my file.txt b/your file.txt',
	'similarity index 50%',
	'rename from my file.txt',
	'rename to your file.txt',
	'index 7898192..422c2b7 100644',
	'--- a/my file.txt\t',
	'+++ b/your file.txt\t',
	'@@ -1,0 +2 @@ a',
	'+b',
	'',
].join('\n');

describe('Code Review Kit — parseNumstat', () => {
	const files = parseNumstat(NUMSTAT);

	it('joins raw statuses with numstat counts, in order', () => {
		assert.deepEqual(files, [
			{ path: 'after.txt', oldPath: 'before.txt', status: 'renamed', additions: 1, deletions: 0 },
			{ path: 'app.txt', status: 'modified', additions: 3, deletions: 0 },
			{ path: 'ação.txt', status: 'modified', additions: 2, deletions: 1 },
			{ path: 'bin.dat', status: 'modified', additions: null, deletions: null },
			{ path: 'new.txt', status: 'added', additions: 3, deletions: 0 },
			{ path: 'old.txt', status: 'deleted', additions: 0, deletions: 2 },
			{ path: 'with space.txt', status: 'modified', additions: 1, deletions: 0 },
		]);
	});

	it('keeps a tab and a quote inside a NUL-separated path', () => {
		const text =
			':100644 100644 bca70f3 92812c3 M\0we"ird\tname.txt\0' +
			':100644 100644 7898192 422c2b7 R050\0my file.txt\0your file.txt\0' +
			'1\t0\twe"ird\tname.txt\0' +
			'1\t0\t\0my file.txt\0your file.txt\0';
		assert.deepEqual(parseNumstat(text), [
			{ path: 'we"ird\tname.txt', status: 'modified', additions: 1, deletions: 0 },
			{
				path: 'your file.txt',
				oldPath: 'my file.txt',
				status: 'renamed',
				additions: 1,
				deletions: 0,
			},
		]);
	});

	it('reads plain numstat as modified when no raw records came with it', () => {
		assert.deepEqual(parseNumstat('3\t1\ta.ts\0'), [
			{ path: 'a.ts', status: 'modified', additions: 3, deletions: 1 },
		]);
		// A rename in plain numstat: the new side is the second of the two paths.
		assert.deepEqual(parseNumstat('1\t0\t\0before.txt\0after.txt\0'), [
			{ path: 'after.txt', status: 'modified', additions: 1, deletions: 0 },
		]);
	});

	it('returns nothing for an empty diff', () => {
		assert.deepEqual(parseNumstat(''), []);
	});
});

describe('Code Review Kit — parseAddedLines', () => {
	it('numbers added lines on the new side across hunks, new files and renames', () => {
		assert.deepEqual(parseAddedLines(PATCH), {
			'after.txt': [6],
			'app.txt': [2, 9, 10],
			'ação.txt': [1, 2],
			'new.txt': [1, 2, 3],
			'with space.txt': [2],
		});
	});

	it('gives a deletions-only file an empty list and treats "+++ x" inside a hunk as content', () => {
		assert.deepEqual(parseAddedLines(PATCH_EDGES), {
			'app.txt': [],
			'plus.txt': [2, 3],
			'we"ird\tname.txt': [2],
			'your file.txt': [2],
		});
	});

	it('advances over context lines when the patch has them', () => {
		const patch = [
			'--- a/x.ts',
			'+++ b/x.ts',
			'@@ -3,3 +3,4 @@',
			' same',
			'+added',
			' same',
			'-gone',
			'+swapped',
			'',
		].join('\n');
		assert.deepEqual(parseAddedLines(patch), { 'x.ts': [4, 6] });
	});

	it('returns nothing for an empty patch', () => {
		assert.deepEqual(parseAddedLines(''), {});
	});
});

describe('Code Review Kit — completeAddedLines', () => {
	it('lists every surviving file, including ones with no +++ header, and never a deleted one', () => {
		const files = parseNumstat(NUMSTAT);
		const complete = completeAddedLines(files, parseAddedLines(PATCH));
		assert.deepEqual(Object.keys(complete), [
			'after.txt',
			'app.txt',
			'ação.txt',
			'bin.dat',
			'new.txt',
			'with space.txt',
		]);
		assert.deepEqual(complete['bin.dat'], []);
		assert.equal('old.txt' in complete, false);
	});
});

describe('Code Review Kit — unquoteGitPath', () => {
	it('undoes C escapes and octal UTF-8 bytes, and leaves unquoted names alone', () => {
		assert.equal(unquoteGitPath('"b/we\\"ird\\tname.txt"'), 'b/we"ird\tname.txt');
		assert.equal(unquoteGitPath('"b/a\\303\\247\\303\\243o.txt"'), 'b/ação.txt');
		assert.equal(unquoteGitPath('"b/back\\\\slash"'), 'b/back\\slash');
		assert.equal(unquoteGitPath('b/plain name.txt'), 'b/plain name.txt');
	});
});

describe('Code Review Kit — truncatePatch', () => {
	it('returns the patch untouched under the cap, or with no cap', () => {
		assert.deepEqual(truncatePatch(PATCH, PATCH.length), { text: PATCH, truncated: false });
		assert.deepEqual(truncatePatch(PATCH, 0), { text: PATCH, truncated: false });
	});

	it('cuts at a line break and says how much it kept', () => {
		const out = truncatePatch('aaa\nbbb\nccc\n', 9);
		assert.equal(out.truncated, true);
		assert.equal(out.text, 'aaa\nbbb\n[patch truncated: 8 of 12 characters]\n');
	});

	it('cuts mid-line when the first line alone is over the cap', () => {
		const out = truncatePatch('abcdefghij', 4);
		assert.equal(out.text, 'abcd[patch truncated: 4 of 10 characters]\n');
	});
});
