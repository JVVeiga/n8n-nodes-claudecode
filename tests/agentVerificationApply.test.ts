import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	applyVerdict,
	failedReport,
	parseVerdict,
	skippedReport,
} from '../nodes/ClaudeCodeAgent/verification/apply';

const structured = () => ({
	summary: 'four findings',
	review: {
		verdict: 'changes',
		inline_comments: [
			{ file: 'a.ts', claim: 'A' },
			{ file: 'b.ts', claim: 'B' },
			{ file: 'c.ts', claim: 'C' },
			{ file: 'd.ts', claim: 'D' },
		],
	},
});

const files = (value: unknown): string[] =>
	(value as { review: { inline_comments: Array<{ file: string }> } }).review.inline_comments.map(
		(c) => c.file,
	);

describe('applyVerdict', () => {
	it('removes the dropped items and reports each with its reason and the item itself', () => {
		const { structured: out, report } = applyVerdict(
			structured(),
			'review.inline_comments',
			[0, 1, 2, 3],
			{
				keep: [0, 2],
				drop: [
					{ index: 1, reason: 'b.ts validates it' },
					{ index: 3, reason: 'no' },
				],
			},
		);
		assert.deepEqual(files(out), ['a.ts', 'c.ts']);
		assert.deepEqual(report, {
			status: 'verified',
			checked: 4,
			kept: 2,
			dropped: 2,
			unjudged: [],
			droppedItems: [
				{ index: 1, reason: 'b.ts validates it', item: { file: 'b.ts', claim: 'B' } },
				{ index: 3, reason: 'no', item: { file: 'd.ts', claim: 'D' } },
			],
		});
	});

	it('keeps the rest of the object and never mutates the input', () => {
		const input = structured();
		const snapshot = JSON.parse(JSON.stringify(input));
		const { structured: out } = applyVerdict(input, 'review.inline_comments', [0, 1, 2, 3], {
			keep: [],
			drop: [{ index: 0, reason: 'x' }],
		});
		assert.deepEqual(input, snapshot);
		assert.notEqual(out, input);
		const o = out as ReturnType<typeof structured>;
		assert.equal(o.summary, 'four findings');
		assert.equal(o.review.verdict, 'changes');
	});

	it('an index the verifier did not mention is kept and listed as unjudged', () => {
		const { structured: out, report } = applyVerdict(
			structured(),
			'review.inline_comments',
			[0, 1, 2, 3],
			{ keep: [0], drop: [{ index: 1, reason: 'false' }] },
		);
		assert.deepEqual(files(out), ['a.ts', 'c.ts', 'd.ts']);
		assert.deepEqual(report.unjudged, [2, 3]);
		assert.equal(report.kept, 3);
		assert.equal(report.dropped, 1);
	});

	it('only the selected indices are judged: a drop outside them is ignored', () => {
		const { structured: out, report } = applyVerdict(
			structured(),
			'review.inline_comments',
			[1, 3],
			{
				keep: [1, 0],
				drop: [
					{ index: 0, reason: 'x' },
					{ index: 2, reason: 'y' },
					{ index: 9, reason: 'z' },
				],
			},
		);
		assert.deepEqual(files(out), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
		assert.equal(report.checked, 2);
		assert.equal(report.kept, 2);
		assert.equal(report.dropped, 0);
		assert.deepEqual(report.unjudged, [3]);
	});

	it('an index both kept and dropped is kept', () => {
		const { structured: out, report } = applyVerdict(
			structured(),
			'review.inline_comments',
			[0, 1],
			{ keep: [0, 1], drop: [{ index: 1, reason: 'unsure' }] },
		);
		assert.deepEqual(files(out), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
		assert.equal(report.dropped, 0);
		assert.deepEqual(report.unjudged, []);
	});

	it('the first reason wins when an index is dropped twice', () => {
		const { report } = applyVerdict(structured(), 'review.inline_comments', [0], {
			keep: [],
			drop: [
				{ index: 0, reason: 'first' },
				{ index: 0, reason: 'second' },
			],
		});
		assert.equal(report.dropped, 1);
		assert.equal(report.droppedItems[0].reason, 'first');
	});

	it('works on a top-level array', () => {
		const { structured: out } = applyVerdict({ items: ['x', 'y', 'z'] }, 'items', [0, 1, 2], {
			keep: [0, 2],
			drop: [{ index: 1, reason: 'r' }],
		});
		assert.deepEqual(out, { items: ['x', 'z'] });
	});
});

describe('parseVerdict', () => {
	it('accepts the schema shape and drops entries that are not integers', () => {
		assert.deepEqual(
			parseVerdict({
				keep: [0, 1.5, '2', 3],
				drop: [{ index: 1, reason: 'r' }, { index: 'x', reason: 'r' }, 'bad', { index: 2 }],
			}),
			{
				keep: [0, 3],
				drop: [
					{ index: 1, reason: 'r' },
					{ index: 2, reason: '' },
				],
			},
		);
	});

	it('rejects anything without both arrays', () => {
		for (const raw of [null, 'x', [], { keep: [] }, { drop: [] }, { keep: {}, drop: [] }]) {
			assert.equal(parseVerdict(raw), null, JSON.stringify(raw));
		}
	});
});

describe('failedReport and skippedReport', () => {
	it('a failed verification drops nothing and keeps every checked item', () => {
		assert.deepEqual(failedReport('the verification run timed out', 3), {
			status: 'failed',
			reason: 'the verification run timed out',
			checked: 3,
			kept: 3,
			dropped: 0,
			unjudged: [],
			droppedItems: [],
		});
	});

	it('an empty selection is skipped with nothing checked', () => {
		assert.deepEqual(skippedReport(), {
			status: 'skipped',
			checked: 0,
			kept: 0,
			dropped: 0,
			unjudged: [],
			droppedItems: [],
		});
	});
});
