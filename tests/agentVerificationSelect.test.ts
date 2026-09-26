import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectItems } from '../nodes/ClaudeCodeAgent/verification/select';

const review = {
	summary: 'two findings',
	review: {
		inline_comments: [
			{ file: 'a.ts', severity: 'high' },
			{ file: 'b.ts', severity: 'low' },
			{ file: 'c.ts', severity: ' HIGH ' },
			{ file: 'd.ts', severity: 'medium' },
			'not an object',
		],
	},
};

describe('selectItems — the path', () => {
	it('follows a nested dot path and returns every item with its index', () => {
		const selection = selectItems(review, 'review.inline_comments', null);
		assert.ok('items' in selection);
		assert.equal(selection.items.length, 5);
		assert.deepEqual(selection.indices, [0, 1, 2, 3, 4]);
		assert.deepEqual(selection.items[1], { file: 'b.ts', severity: 'low' });
	});

	it('reads a top-level array', () => {
		const selection = selectItems({ findings: ['x', 'y'] }, 'findings', null);
		assert.deepEqual(selection, { items: ['x', 'y'], indices: [0, 1] });
	});

	it('an empty array is an empty selection, not a problem', () => {
		assert.deepEqual(selectItems({ findings: [] }, 'findings', null), { items: [], indices: [] });
	});

	it('tolerates spaces around the segments', () => {
		const selection = selectItems(review, ' review . inline_comments ', null);
		assert.ok('items' in selection);
		assert.equal(selection.items.length, 5);
	});

	const problems: Array<[string, unknown, string, RegExp]> = [
		['an empty path', review, '', /Items Path is empty/],
		['a blank path', review, ' . ', /Items Path is empty/],
		['a missing key', review, 'review.comments', /"review.comments".*found nothing there/],
		['a broken chain', review, 'summary.items', /"summary.items".*found nothing there/],
		['an object', review, 'review', /"review".*found an object there/],
		['a string', review, 'summary', /"summary".*found a string there/],
		['null', { findings: null }, 'findings', /found null there/],
		['a number', { findings: 3 }, 'findings', /found a number there/],
		['a structured value that is not an object', 'text', 'findings', /found nothing there/],
	];
	for (const [label, structured, path, pattern] of problems) {
		it(`${label} is a Problem naming the path and what was found`, () => {
			const selection = selectItems(structured, path, null);
			assert.ok('problem' in selection, label);
			assert.match(selection.problem.message, pattern);
			assert.match(selection.problem.description ?? '', /dot path/);
		});
	}
});

describe('selectItems — the filter', () => {
	it('keeps items whose field equals one of the values, trimmed, with original indices', () => {
		const selection = selectItems(review, 'review.inline_comments', {
			field: 'severity',
			values: ['high', 'medium'],
		});
		assert.ok('items' in selection);
		assert.deepEqual(selection.indices, [0, 3]);
		assert.deepEqual(
			selection.items.map((i) => (i as { file: string }).file),
			['a.ts', 'd.ts'],
		);
	});

	it('compares as strings and is case-sensitive', () => {
		const selection = selectItems(review, 'review.inline_comments', {
			field: 'severity',
			values: ['HIGH'],
		});
		assert.ok('items' in selection);
		assert.deepEqual(selection.indices, [2]);
	});

	it('matches numbers and booleans by their string form', () => {
		const selection = selectItems(
			{ findings: [{ p: 1 }, { p: 2 }, { p: true }, { p: null }, {}] },
			'findings',
			{ field: 'p', values: ['2', 'true'] },
		);
		assert.ok('items' in selection);
		assert.deepEqual(selection.indices, [1, 2]);
	});

	it('trims the configured values too', () => {
		const selection = selectItems(review, 'review.inline_comments', {
			field: 'severity',
			values: [' low '],
		});
		assert.ok('items' in selection);
		assert.deepEqual(selection.indices, [1]);
	});

	it('no values selects everything, including non-objects', () => {
		const selection = selectItems(review, 'review.inline_comments', {
			field: 'severity',
			values: [],
		});
		assert.ok('items' in selection);
		assert.deepEqual(selection.indices, [0, 1, 2, 3, 4]);
	});

	it('nothing matching is an empty selection', () => {
		const selection = selectItems(review, 'review.inline_comments', {
			field: 'severity',
			values: ['critical'],
		});
		assert.deepEqual(selection, { items: [], indices: [] });
	});
});
