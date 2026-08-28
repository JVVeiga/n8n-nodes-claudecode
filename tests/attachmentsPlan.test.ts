import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planAttachments, stagedHintBlock } from '../nodes/ClaudeCode/attachments/plan';
import type { Attachment, AttachmentSpec } from '../nodes/ClaudeCode/attachments/types';

const spec = (over: Partial<AttachmentSpec> = {}): AttachmentSpec => ({
	all: false,
	names: [],
	inlineTextLimitKb: 256,
	maxAttachmentMb: 50,
	maxAttachmentCount: 16,
	...over,
});

/** `bytes` follows the buffer unless a test overrides it deliberately — routing reads `bytes`, so a
 * helper that let the two drift would let a test assert on an impossible attachment. */
const attachment = (over: Partial<Attachment> = {}): Attachment => {
	const buffer = over.buffer ?? Buffer.from('hello', 'utf8');
	return {
		propName: 'data',
		fileName: 'file.txt',
		mimeType: 'text/plain',
		...over,
		bytes: over.bytes ?? buffer.length,
		buffer,
	};
};

const png = (bytes = 64) => Buffer.alloc(bytes, 0x41);

describe('planAttachments — the empty case', () => {
	it('produces nothing at all, which is what keeps a no-attachment run byte-identical', () => {
		const plan = planAttachments([], spec());
		assert.deepEqual(plan.blocks, []);
		assert.deepEqual(plan.toStage, []);
		assert.equal(plan.report, null);
		assert.deepEqual(plan.notes, {});
	});
});

describe('planAttachments — images', () => {
	it('emits a naming text block BEFORE the image, because ImageBlockParam has no title', () => {
		const plan = planAttachments(
			[attachment({ fileName: 'shot.png', mimeType: 'image/png', buffer: png() })],
			spec(),
		);
		assert.equal(plan.blocks.length, 2);
		assert.equal(plan.blocks[0].type, 'text');
		assert.match(
			(plan.blocks[0] as { text: string }).text,
			/^Image: shot\.png \(64 B, image\/png\)$/,
		);
		assert.equal(plan.blocks[1].type, 'image');
	});

	it('sends base64 of the exact bytes, with the routed media type', () => {
		const buffer = png(10);
		const plan = planAttachments(
			[attachment({ fileName: 'a.jpg', mimeType: 'image/jpeg', buffer })],
			spec(),
		);
		const block = plan.blocks[1] as { source: { type: string; media_type: string; data: string } };
		assert.equal(block.source.type, 'base64');
		assert.equal(block.source.media_type, 'image/jpeg');
		assert.ok(Buffer.from(block.source.data, 'base64').equals(buffer));
	});

	it('normalises image/jpg to image/jpeg on the wire', () => {
		const plan = planAttachments(
			[attachment({ fileName: 'a.jpg', mimeType: 'image/jpg', buffer: png() })],
			spec(),
		);
		assert.equal(
			(plan.blocks[1] as { source: { media_type: string } }).source.media_type,
			'image/jpeg',
		);
	});
});

describe('planAttachments — documents', () => {
	it('titles a text document with the derived filename', () => {
		const plan = planAttachments(
			[attachment({ fileName: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n') })],
			spec(),
		);
		assert.equal(plan.blocks.length, 1);
		assert.deepEqual(plan.blocks[0], {
			type: 'document',
			title: 'export.csv',
			source: { type: 'text', media_type: 'text/plain', data: 'a,b\n' },
		});
	});

	it('sends a PDF as base64 with the pdf media type', () => {
		const buffer = Buffer.from('%PDF-1.4\n');
		const plan = planAttachments(
			[attachment({ fileName: 'i.pdf', mimeType: 'application/pdf', buffer })],
			spec(),
		);
		const block = plan.blocks[0] as {
			title: string;
			source: { type: string; media_type: string; data: string };
		};
		assert.equal(block.title, 'i.pdf');
		assert.equal(block.source.media_type, 'application/pdf');
		assert.ok(Buffer.from(block.source.data, 'base64').equals(buffer));
	});

	it('decodes a text document as UTF-8, not base64', () => {
		const plan = planAttachments(
			[attachment({ mimeType: 'text/plain', buffer: Buffer.from('coração 日本語', 'utf8') })],
			spec(),
		);
		assert.equal((plan.blocks[0] as { source: { data: string } }).source.data, 'coração 日本語');
	});
});

describe('planAttachments — staging', () => {
	it('emits no inline block for a staged file, and lists it in toStage', () => {
		const plan = planAttachments(
			[attachment({ fileName: 'a.zip', mimeType: 'application/zip' })],
			spec(),
		);
		assert.deepEqual(plan.blocks, []);
		assert.deepEqual(
			plan.toStage.map((a) => a.fileName),
			['a.zip'],
		);
	});

	it('stages a text file over the limit and inlines one under it, in the same plan', () => {
		const plan = planAttachments(
			[
				attachment({ fileName: 'small.csv', mimeType: 'text/csv', buffer: Buffer.alloc(100) }),
				attachment({ fileName: 'big.csv', mimeType: 'text/csv', buffer: Buffer.alloc(5000) }),
			],
			spec({ inlineTextLimitKb: 1 }),
		);
		assert.equal(plan.blocks.length, 1);
		assert.deepEqual(
			plan.toStage.map((a) => a.fileName),
			['big.csv'],
		);
	});
});

describe('planAttachments — order', () => {
	it('keeps collection order across mixed routes', () => {
		const plan = planAttachments(
			[
				attachment({ fileName: 'one.csv', mimeType: 'text/csv', buffer: Buffer.from('1') }),
				attachment({ fileName: 'two.png', mimeType: 'image/png', buffer: png() }),
				attachment({ fileName: 'three.zip', mimeType: 'application/zip' }),
				attachment({ fileName: 'four.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%') }),
			],
			spec(),
		);
		// one.csv (document), two.png (text + image), four.pdf (document). three.zip stages.
		assert.deepEqual(
			plan.blocks.map((b) => b.type),
			['document', 'text', 'image', 'document'],
		);
		assert.equal((plan.blocks[0] as { title: string }).title, 'one.csv');
		assert.equal((plan.blocks[3] as { title: string }).title, 'four.pdf');
	});
});

describe('planAttachments — the diagnostics report', () => {
	it('counts every attachment and sums every byte, inline and staged alike', () => {
		const plan = planAttachments(
			[
				attachment({ fileName: 'a.csv', mimeType: 'text/csv', buffer: Buffer.alloc(100) }),
				attachment({ fileName: 'b.zip', mimeType: 'application/zip', buffer: Buffer.alloc(900) }),
			],
			spec(),
		);
		assert.equal(plan.report?.count, 2);
		assert.equal(plan.report?.totalBytes, 1000);
	});

	it('records how each inlined file was sent', () => {
		const plan = planAttachments(
			[
				attachment({ fileName: 'a.csv', mimeType: 'text/csv', buffer: Buffer.from('x') }),
				attachment({ fileName: 'b.png', mimeType: 'image/png', buffer: png(5) }),
				attachment({ fileName: 'c.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%') }),
			],
			spec(),
		);
		assert.deepEqual(
			plan.report?.inline.map((i) => [i.name, i.as]),
			[
				['a.csv', 'document-text'],
				['b.png', 'image'],
				['c.pdf', 'document-pdf'],
			],
		);
	});

	it('reports staged as null when everything went inline', () => {
		const plan = planAttachments(
			[attachment({ mimeType: 'text/plain', buffer: Buffer.from('x') })],
			spec(),
		);
		assert.equal(plan.report?.staged, null);
	});

	it('lists the staged files with an empty dir for the node to fill in', () => {
		const plan = planAttachments(
			[attachment({ fileName: 'a.zip', mimeType: 'application/zip', buffer: Buffer.alloc(7) })],
			spec(),
		);
		assert.deepEqual(plan.report?.staged, {
			dir: '',
			files: [{ name: 'a.zip', mimeType: 'application/zip', bytes: 7 }],
		});
	});
});

describe('planAttachments — debug notes', () => {
	it('reports the route chosen per file, with the reason when staged', () => {
		const plan = planAttachments(
			[
				attachment({ fileName: 'a.png', mimeType: 'image/png', buffer: png() }),
				attachment({ fileName: 'b.zip', mimeType: 'application/zip' }),
				attachment({ fileName: 'c.csv', mimeType: 'text/csv', buffer: Buffer.alloc(5000) }),
			],
			spec({ inlineTextLimitKb: 1 }),
		);
		assert.deepEqual(plan.notes.attachmentRoutes, {
			'a.png': 'image (image/png)',
			'b.zip': 'staged (no-inline-route)',
			'c.csv': 'staged (over-inline-limit)',
		});
		assert.equal(plan.notes.attachmentCount, 3);
		assert.equal(plan.notes.attachmentStaged, 2);
		assert.equal(plan.notes.attachmentInlineBlocks, 2);
	});
});

describe('stagedHintBlock', () => {
	it('names the directory and every file, and says to use Read', () => {
		const block = stagedHintBlock('/tmp/n8n-claude-abc', [
			{ name: 'dump.csv', mimeType: 'text/csv', bytes: 42 * 1024 * 1024 },
			{ name: 'data.xlsx', mimeType: 'application/vnd.ms-excel', bytes: 2048 },
		]) as { type: string; text: string };

		assert.equal(block.type, 'text');
		assert.match(block.text, /dir="\/tmp\/n8n-claude-abc"/);
		assert.match(block.text, /dump\.csv \(42\.0 MB, text\/csv\)/);
		assert.match(block.text, /data\.xlsx \(2 KB, application\/vnd\.ms-excel\)/);
		assert.match(block.text, /Read tool/);
	});
});
