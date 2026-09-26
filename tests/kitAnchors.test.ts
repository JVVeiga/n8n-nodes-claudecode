import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateAnchors } from '../nodes/CodeReviewKit/anchors';

const ADDED = { 'src/app.ts': [2, 9, 10], 'src/empty.ts': [] };
const FIELDS = { path: 'path', line: 'line' };

describe('Code Review Kit — validateAnchors', () => {
	it('keeps an item on an added line', () => {
		const item = { path: 'src/app.ts', line: 9, body: 'x' };
		assert.deepEqual(validateAnchors([item], ADDED, FIELDS), { valid: [item], moved: [] });
	});

	it('tells a file outside the diff apart from a line that was not added', () => {
		const outside = { path: 'src/other.ts', line: 1 };
		const unchanged = { path: 'src/app.ts', line: 3 };
		const noAdds = { path: 'src/empty.ts', line: 1 };
		const { valid, moved } = validateAnchors([outside, unchanged, noAdds], ADDED, FIELDS);
		assert.deepEqual(valid, []);
		assert.deepEqual(moved, [
			{ item: outside, reason: 'file is not in the diff (or was deleted): src/other.ts' },
			{ item: unchanged, reason: 'line 3 is not an added line in src/app.ts' },
			{ item: noAdds, reason: 'line 1 is not an added line in src/empty.ts' },
		]);
	});

	it('moves items with the wrong types, with a reason, and discards nothing', () => {
		const items = [
			{ path: 'src/app.ts', line: '9' },
			{ path: 'src/app.ts', line: 2.5 },
			{ path: 'src/app.ts', line: 0 },
			{ path: '', line: 2 },
			{ line: 2 },
			'not an object',
			null,
			[1, 2],
		];
		const { valid, moved } = validateAnchors(items, ADDED, FIELDS);
		assert.equal(valid.length, 0);
		assert.equal(moved.length, items.length);
		assert.deepEqual(
			moved.map((m) => m.item),
			items,
		);
		assert.equal(moved[0].reason, '"line" must be a positive integer (got string "9")');
		assert.equal(moved[4].reason, '"path" must be a non-empty string (got nothing)');
		assert.equal(moved[5].reason, 'item is not an object (got string "not an object")');
	});

	it('reads the configured field names', () => {
		const item = { file: 'src/app.ts', startLine: 10 };
		const out = validateAnchors([item], ADDED, { path: 'file', line: 'startLine' });
		assert.deepEqual(out.valid, [item]);
	});

	it('does not treat an inherited property as a file in the diff', () => {
		const { moved } = validateAnchors([{ path: 'constructor', line: 1 }], ADDED, FIELDS);
		assert.equal(moved[0].reason, 'file is not in the diff (or was deleted): constructor');
	});
});
