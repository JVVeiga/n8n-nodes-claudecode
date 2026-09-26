import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dedupe } from '../nodes/CodeReviewKit/dedupe';

const FIELDS = { fingerprint: 'fingerprint', status: 'status', openValue: 'open' };

describe('Code Review Kit — dedupe', () => {
	it('splits into new, repeated (with the previous item) and resolved', () => {
		const repeatedNew = { fingerprint: 'aaa', title: 'still here' };
		const freshNew = { fingerprint: 'bbb', title: 'first time' };
		const prevOpen = { fingerprint: 'aaa', status: 'open', id: 11 };
		const prevGone = { fingerprint: 'ccc', status: 'open', id: 12 };
		const prevClosed = { fingerprint: 'ddd', status: 'dismissed', id: 13 };

		assert.deepEqual(dedupe([repeatedNew, freshNew], [prevOpen, prevGone, prevClosed], FIELDS), {
			new: [freshNew],
			repeated: [{ item: repeatedNew, previous: prevOpen }],
			resolved: [prevGone],
		});
	});

	it('repeats against a previous item of any status, carrying that status', () => {
		const item = { fingerprint: 'x' };
		const previous = { fingerprint: 'x', status: 'dismissed', id: 'c-1' };
		const out = dedupe([item], [previous], FIELDS);
		assert.deepEqual(out.repeated, [{ item, previous }]);
		assert.deepEqual(out.resolved, []);
	});

	it('points a repeat at the open previous item when there are duplicates', () => {
		const closed = { fingerprint: 'x', status: 'fixed', id: 1 };
		const open = { fingerprint: 'x', status: 'open', id: 2 };
		const out = dedupe([{ fingerprint: 'x' }], [closed, open], FIELDS);
		assert.equal(out.repeated[0].previous, open);
	});

	it('treats a new item without a fingerprint as new, and never resolves one without', () => {
		const out = dedupe(
			[{ fingerprint: null }, { title: 'none' }, 'odd'],
			[
				{ status: 'open', id: 1 },
				{ fingerprint: '', status: 'open' },
			],
			FIELDS,
		);
		assert.equal(out.new.length, 3);
		assert.deepEqual(out.repeated, []);
		assert.deepEqual(out.resolved, []);
	});

	it('reads the configured field names and open value', () => {
		const out = dedupe(
			[{ fp: 'k' }],
			[
				{ fp: 'k', state: 'OPEN' },
				{ fp: 'z', state: 'OPEN' },
				{ fp: 'y', state: 'open' },
			],
			{ fingerprint: 'fp', status: 'state', openValue: 'OPEN' },
		);
		assert.equal(out.repeated.length, 1);
		assert.deepEqual(out.resolved, [{ fp: 'z', state: 'OPEN' }]);
	});

	it('compares a non-string status by its text', () => {
		const out = dedupe([], [{ fingerprint: 'a', status: 1 }], { ...FIELDS, openValue: '1' });
		assert.equal(out.resolved.length, 1);
	});
});
