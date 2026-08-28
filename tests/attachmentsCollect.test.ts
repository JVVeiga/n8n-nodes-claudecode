import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectAttachments } from '../nodes/ClaudeCode/attachments/collect';
import type { Attachment, AttachmentSpec } from '../nodes/ClaudeCode/attachments/types';
import { binaryProperty, createFakeContext, itemWithBinary } from './helpers/executeFunctions';

const spec = (over: Partial<AttachmentSpec> = {}): AttachmentSpec => ({
	all: false,
	names: [],
	inlineTextLimitKb: 256,
	maxAttachmentMb: 50,
	maxAttachmentCount: 16,
	...over,
});

type Binaries = Record<string, ReturnType<typeof binaryProperty>>;

const collect = async (binaries: Binaries, over: Partial<AttachmentSpec> = {}) => {
	const { ctx } = createFakeContext({ items: [itemWithBinary(binaries)] });
	return collectAttachments(ctx, 0, spec(over));
};

const ok = async (
	binaries: Binaries,
	over: Partial<AttachmentSpec> = {},
): Promise<Attachment[]> => {
	const outcome = await collect(binaries, over);
	assert.ok('attachments' in outcome, `expected attachments, got ${JSON.stringify(outcome)}`);
	return outcome.attachments;
};

const problemOf = async (binaries: Binaries, over: Partial<AttachmentSpec> = {}) => {
	const outcome = await collect(binaries, over);
	assert.ok('problem' in outcome, 'expected a problem, got attachments');
	return outcome.problem;
};

describe('collectAttachments — nothing to do', () => {
	it('returns an empty list when nothing is selected, without reading the item', async () => {
		assert.deepEqual(await ok({ data: binaryProperty('x') }), []);
	});

	it('returns an empty list when all is on but the item carries no binary at all', async () => {
		const { ctx } = createFakeContext({ items: [{ json: {} }] });
		const outcome = await collectAttachments(ctx, 0, spec({ all: true }));
		assert.ok('attachments' in outcome);
		assert.deepEqual(outcome.attachments, []);
	});

	it('is not a problem for a missing name when the list is empty', async () => {
		assert.deepEqual(await ok({}, { names: [] }), []);
	});
});

describe('collectAttachments — selection', () => {
	it('reads the named properties, in the order given', async () => {
		const found = await ok(
			{
				b: binaryProperty('bee', { fileName: 'b.txt', mimeType: 'text/plain' }),
				a: binaryProperty('ay', { fileName: 'a.txt', mimeType: 'text/plain' }),
			},
			{ names: ['b', 'a'] },
		);
		assert.deepEqual(
			found.map((f) => f.propName),
			['b', 'a'],
		);
	});

	it('sorts when all is on, so the model sees a stable order across runs', async () => {
		const found = await ok(
			{
				data_2: binaryProperty('2', { mimeType: 'text/plain' }),
				data_10: binaryProperty('10', { mimeType: 'text/plain' }),
				data_1: binaryProperty('1', { mimeType: 'text/plain' }),
			},
			{ all: true },
		);
		// Lexicographic, not numeric — the guarantee is stability, not human ordering.
		assert.deepEqual(
			found.map((f) => f.propName),
			['data_1', 'data_10', 'data_2'],
		);
	});

	it('ignores the name list when all is on', async () => {
		const found = await ok(
			{
				a: binaryProperty('a', { mimeType: 'text/plain' }),
				b: binaryProperty('b', { mimeType: 'text/plain' }),
			},
			{ all: true, names: ['a'] },
		);
		assert.equal(found.length, 2);
	});
});

describe('collectAttachments — what it produces', () => {
	it('carries the bytes through unchanged', async () => {
		const content = 'sku,qty\nWIDGET,412\n';
		const [found] = await ok(
			{ data: binaryProperty(content, { fileName: 'e.csv', mimeType: 'text/csv' }) },
			{ names: ['data'] },
		);
		assert.equal(found.buffer.toString('utf8'), content);
		assert.equal(found.bytes, Buffer.byteLength(content));
	});

	it('handles binary bytes, not just text', async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
		const [found] = await ok(
			{ data: binaryProperty(png, { fileName: 's.png', mimeType: 'image/png' }) },
			{ names: ['data'] },
		);
		assert.ok(found.buffer.equals(png));
	});

	it('derives a name, and makes two same-named properties distinct', async () => {
		const found = await ok(
			{
				a: binaryProperty('1', { fileName: 'shot.png', mimeType: 'image/png' }),
				b: binaryProperty('2', { fileName: 'shot.png', mimeType: 'image/png' }),
			},
			{ names: ['a', 'b'] },
		);
		assert.deepEqual(
			found.map((f) => f.fileName),
			['shot.png', 'shot-2.png'],
		);
	});

	it('resolves the MIME type rather than repeating what n8n claimed', async () => {
		const [found] = await ok(
			{
				data: binaryProperty('a,b\n1,2\n', {
					fileName: 'export.csv',
					mimeType: 'application/octet-stream',
				}),
			},
			{ names: ['data'] },
		);
		assert.equal(found.mimeType, 'text/csv');
	});

	it('resolves a type from the bytes when neither MIME nor extension helps', async () => {
		const [found] = await ok({ data: binaryProperty('plain words', {}) }, { names: ['data'] });
		assert.equal(found.mimeType, 'text/plain');
	});
});

describe('collectAttachments — failures', () => {
	it('names the missing property, and lists what the item does have', async () => {
		const problem = await problemOf(
			{ data: binaryProperty('x', { mimeType: 'text/plain' }) },
			{ names: ['screenshot'] },
		);
		assert.match(problem.message, /no binary property named "screenshot"/);
		assert.match(problem.description ?? '', /these binary properties: data/);
	});

	it('says so plainly when the item has no binary data at all', async () => {
		const problem = await problemOf({}, { names: ['data'] });
		assert.match(problem.description ?? '', /no binary data at all/);
	});

	it('names the property, its size and the limit when a file is too big', async () => {
		const problem = await problemOf(
			{ data: binaryProperty(Buffer.alloc(3 * 1024 * 1024), { mimeType: 'text/plain' }) },
			{ names: ['data'], maxAttachmentMb: 2 },
		);
		assert.match(problem.message, /"data" is 3\.0 MB/);
		assert.match(problem.message, /limit of 2 MB/);
	});

	it('reports both numbers when there are too many attachments', async () => {
		const binaries: Binaries = {};
		for (let i = 0; i < 5; i++) binaries[`d${i}`] = binaryProperty('x', { mimeType: 'text/plain' });
		const problem = await problemOf(binaries, { all: true, maxAttachmentCount: 3 });
		assert.match(problem.message, /Too many attachments: 5/);
		assert.match(problem.message, /limit of 3/);
	});

	it('checks the count before the size, so the message names the fixable thing', async () => {
		const big = binaryProperty(Buffer.alloc(2 * 1024 * 1024), { mimeType: 'text/plain' });
		const problem = await problemOf(
			{ a: big, b: big, c: big },
			{ all: true, maxAttachmentCount: 2, maxAttachmentMb: 1 },
		);
		assert.match(problem.message, /Too many attachments/);
	});

	it('accepts a file exactly at the size limit', async () => {
		const found = await ok(
			{ data: binaryProperty(Buffer.alloc(1024 * 1024), { mimeType: 'text/plain' }) },
			{ names: ['data'], maxAttachmentMb: 1 },
		);
		assert.equal(found.length, 1);
	});

	it('returns problems rather than throwing, so the node owns the error shape', async () => {
		// If it threw, this await would reject rather than resolving to a problem.
		const outcome = await collect({}, { names: ['nope'] });
		assert.ok('problem' in outcome);
	});
});

describe('collectAttachments — per item', () => {
	it('reads the item at the given index, not the first one', async () => {
		const { ctx } = createFakeContext({
			items: [
				itemWithBinary({ data: binaryProperty('first', { mimeType: 'text/plain' }) }),
				itemWithBinary({ data: binaryProperty('second', { mimeType: 'text/plain' }) }),
			],
		});
		const outcome = await collectAttachments(ctx, 1, spec({ names: ['data'] }));
		assert.ok('attachments' in outcome);
		assert.equal(outcome.attachments[0].buffer.toString('utf8'), 'second');
	});
});
