import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	INLINE_CEILINGS,
	effectiveMime,
	extensionForMime,
	extensionOf,
	isTextualMime,
	normalizeMime,
	routeFor,
	sniffText,
} from '../nodes/ClaudeCode/attachments/mime';
import type { AttachmentSpec, Route } from '../nodes/ClaudeCode/attachments/types';

const spec = (over: Partial<AttachmentSpec> = {}): AttachmentSpec => ({
	all: false,
	names: [],
	inlineTextLimitKb: 256,
	maxAttachmentMb: 50,
	maxAttachmentCount: 16,
	allowedExtensions: [],
	...over,
});

/** A buffer of `n` bytes. Content is irrelevant to routing, only the length is. */
const bytes = (n: number): number => n;

const KB = 1024;
const MB = 1024 * KB;

const route = (mime: string, size: number, over: Partial<AttachmentSpec> = {}): Route =>
	routeFor(mime, size, spec(over));

describe('normalizeMime', () => {
	it('strips parameters and case', () => {
		assert.equal(normalizeMime('Text/CSV; charset=utf-8'), 'text/csv');
	});

	it('treats a missing type as empty rather than throwing', () => {
		assert.equal(normalizeMime(undefined), '');
	});
});

describe('extensionOf', () => {
	it('lowercases and drops the dot', () => {
		assert.equal(extensionOf('Report.PNG'), 'png');
	});

	it('has none for a bare name, a dotfile, or a trailing dot', () => {
		assert.equal(extensionOf('report'), '');
		// A leading dot is the whole name, not an extension — `.gitignore` is not a `gitignore` file.
		assert.equal(extensionOf('.gitignore'), '');
		assert.equal(extensionOf('report.'), '');
	});

	it('takes the last extension of several', () => {
		assert.equal(extensionOf('archive.tar.gz'), 'gz');
	});
});

describe('extensionForMime', () => {
	it('maps both jpeg spellings to jpg', () => {
		assert.equal(extensionForMime('image/jpeg'), 'jpg');
		assert.equal(extensionForMime('image/jpg'), 'jpg');
	});

	it('is empty for a type it does not know', () => {
		assert.equal(extensionForMime('application/x-made-up'), '');
		assert.equal(extensionForMime(undefined), '');
	});
});

describe('routeFor — images', () => {
	it('inlines the four media types the API accepts', () => {
		for (const [mime, expected] of [
			['image/png', 'image/png'],
			['image/jpeg', 'image/jpeg'],
			['image/gif', 'image/gif'],
			['image/webp', 'image/webp'],
		] as const) {
			assert.deepEqual(route(mime, bytes(1000)), { kind: 'image', mediaType: expected });
		}
	});

	it('normalises image/jpg onto image/jpeg — the API has no image/jpg', () => {
		assert.deepEqual(route('image/jpg', bytes(1000)), {
			kind: 'image',
			mediaType: 'image/jpeg',
		});
	});

	it('stages an image type the API has no media_type for, rather than sending a 400', () => {
		for (const mime of ['image/heic', 'image/bmp', 'image/tiff']) {
			assert.deepEqual(route(mime, bytes(1000)), {
				kind: 'staged',
				reason: 'no-inline-route',
			});
		}
	});

	it('routes image/svg+xml as text — it is XML, and not a valid image media_type', () => {
		assert.deepEqual(route('image/svg+xml', bytes(1000)), { kind: 'document-text' });
	});

	it('stages an image over the 5 MB API ceiling', () => {
		assert.equal(INLINE_CEILINGS.imageBytes, 5 * MB);
		assert.deepEqual(route('image/png', INLINE_CEILINGS.imageBytes), {
			kind: 'image',
			mediaType: 'image/png',
		});
		assert.deepEqual(route('image/png', INLINE_CEILINGS.imageBytes + 1), {
			kind: 'staged',
			reason: 'over-inline-limit',
		});
	});

	it('does not let the text limit affect an image', () => {
		// 1 MB image, 1 KB text limit: the image still inlines.
		assert.deepEqual(route('image/png', bytes(MB), { inlineTextLimitKb: 1 }), {
			kind: 'image',
			mediaType: 'image/png',
		});
	});
});

describe('routeFor — PDFs', () => {
	it('inlines under the 20 MB API ceiling and stages over it', () => {
		assert.equal(INLINE_CEILINGS.pdfBytes, 20 * MB);
		assert.deepEqual(route('application/pdf', INLINE_CEILINGS.pdfBytes), {
			kind: 'document-pdf',
		});
		assert.deepEqual(route('application/pdf', INLINE_CEILINGS.pdfBytes + 1), {
			kind: 'staged',
			reason: 'over-inline-limit',
		});
	});
});

describe('routeFor — text', () => {
	it('inlines any text/* subtype', () => {
		for (const mime of ['text/plain', 'text/csv', 'text/html', 'text/markdown', 'text/x-log']) {
			assert.deepEqual(route(mime, bytes(1000)), { kind: 'document-text' }, mime);
		}
	});

	it('inlines the textual application/* types', () => {
		for (const mime of [
			'application/json',
			'application/xml',
			'application/x-yaml',
			'application/javascript',
			'application/sql',
			'application/x-ndjson',
		]) {
			assert.deepEqual(route(mime, bytes(1000)), { kind: 'document-text' }, mime);
		}
	});

	it('stages a text file over the configured limit, at the byte', () => {
		const limitKb = 4;
		assert.deepEqual(route('text/csv', limitKb * KB, { inlineTextLimitKb: limitKb }), {
			kind: 'document-text',
		});
		assert.deepEqual(route('text/csv', limitKb * KB + 1, { inlineTextLimitKb: limitKb }), {
			kind: 'staged',
			reason: 'over-inline-limit',
		});
	});

	it('stages every text file when the limit is 0 — including an empty one', () => {
		assert.deepEqual(route('text/csv', 0, { inlineTextLimitKb: 0 }), {
			kind: 'document-text',
		});
		assert.deepEqual(route('text/csv', 1, { inlineTextLimitKb: 0 }), {
			kind: 'staged',
			reason: 'over-inline-limit',
		});
	});
});

describe('routeFor — everything else', () => {
	it('stages with reason no-inline-route, never with over-inline-limit', () => {
		for (const mime of [
			'application/zip',
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'application/octet-stream',
			'video/mp4',
			'',
		]) {
			assert.deepEqual(route(mime, bytes(10)), { kind: 'staged', reason: 'no-inline-route' }, mime);
		}
	});

	it('is total — every input returns a route', () => {
		for (const mime of ['', 'x', 'a/b/c', 'IMAGE/PNG']) {
			assert.ok(route(mime, 0).kind);
		}
	});
});

describe('isTextualMime', () => {
	it('accepts by text/ prefix so an unlisted subtype still works', () => {
		assert.equal(isTextualMime('text/x-something-new'), true);
	});

	it('rejects a binary application type', () => {
		assert.equal(isTextualMime('application/zip'), false);
	});
});

describe('sniffText', () => {
	it('accepts plain ASCII and valid multi-byte UTF-8', () => {
		assert.equal(sniffText(Buffer.from('sku,qty\nA,1\n', 'utf8')), true);
		assert.equal(sniffText(Buffer.from('coração — 日本語 🎉', 'utf8')), true);
	});

	it('rejects a buffer containing a NUL byte, even when it decodes cleanly', () => {
		assert.equal(sniffText(Buffer.from([0x61, 0x00, 0x62])), false);
	});

	it('rejects invalid UTF-8 — a lone continuation byte', () => {
		assert.equal(sniffText(Buffer.from([0x41, 0x80, 0x42])), false);
	});

	it('rejects a PNG header', () => {
		assert.equal(sniffText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), false);
	});

	it('accepts an empty buffer — nothing in it is binary', () => {
		assert.equal(sniffText(Buffer.alloc(0)), true);
	});

	it('does not misjudge a large text file whose 64 KB boundary splits a character', () => {
		// Pad so the multi-byte '日' straddles the sniff boundary. Without the walk-back, the
		// truncated sequence would fail the round-trip and the file would sniff as binary.
		const pad = 'a'.repeat(64 * KB - 1);
		const buffer = Buffer.from(`${pad}日${'b'.repeat(100)}`, 'utf8');
		assert.equal(sniffText(buffer), true);
	});

	it('only reads the prefix — binary past 64 KB does not change the verdict', () => {
		const buffer = Buffer.concat([
			Buffer.from('a'.repeat(64 * KB), 'utf8'),
			Buffer.from([0x00, 0xff]),
		]);
		assert.equal(sniffText(buffer), true);
	});
});

describe('effectiveMime', () => {
	it('trusts an informative type from n8n', () => {
		assert.equal(effectiveMime('text/csv', 'x.png', Buffer.from([0x00])), 'text/csv');
	});

	it('falls back to the extension when n8n reported octet-stream', () => {
		assert.equal(
			effectiveMime('application/octet-stream', 'export.csv', Buffer.from([0x00])),
			'text/csv',
		);
	});

	it('falls back to the extension when n8n reported nothing at all', () => {
		assert.equal(effectiveMime(undefined, 'shot.png', Buffer.alloc(0)), 'image/png');
	});

	it('sniffs the bytes when neither type nor extension helps', () => {
		assert.equal(effectiveMime(undefined, 'dump', Buffer.from('a,b\n1,2\n', 'utf8')), 'text/plain');
		assert.equal(
			effectiveMime(undefined, 'dump', Buffer.from([0x89, 0x50, 0x4e, 0x47])),
			'application/octet-stream',
		);
	});

	it('makes a .log file inline as text, which is the whole point of the fallback', () => {
		const mime = effectiveMime('application/octet-stream', 'app.log', Buffer.from('boom', 'utf8'));
		assert.deepEqual(route(mime, bytes(100)), { kind: 'document-text' });
	});
});
