import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	deriveFileName,
	resolveFileName,
	sanitizeFileName,
	uniquifyFileName,
} from '../nodes/ClaudeCode/attachments/name';

describe('sanitizeFileName', () => {
	it('leaves an already-safe name alone', () => {
		assert.equal(sanitizeFileName('monday-export_2.csv', 'fb'), 'monday-export_2.csv');
	});

	it('flattens path separators so the name cannot escape its directory', () => {
		assert.equal(sanitizeFileName('../../etc/passwd', 'fb'), 'etc_passwd');
		assert.equal(sanitizeFileName('..\\..\\windows\\hosts', 'fb'), 'windows_hosts');
	});

	it('collapses runs of unsafe characters into one underscore', () => {
		assert.equal(sanitizeFileName('my file (final).csv', 'fb'), 'my_file_final_.csv');
	});

	it('falls back when the name is missing, empty, or sanitizes to nothing', () => {
		assert.equal(sanitizeFileName(undefined, 'fb'), 'fb');
		assert.equal(sanitizeFileName('', 'fb'), 'fb');
		assert.equal(sanitizeFileName('///', 'fb'), 'fb');
		assert.equal(sanitizeFileName('$$$', 'fb'), 'fb');
	});

	it('falls back for a name that is only dots — those are directory entries, not files', () => {
		assert.equal(sanitizeFileName('.', 'fb'), 'fb');
		assert.equal(sanitizeFileName('..', 'fb'), 'fb');
	});

	it('keeps a leading dot on a real dotfile', () => {
		assert.equal(sanitizeFileName('.gitignore', 'fb'), '.gitignore');
	});
});

describe('deriveFileName — the ladder', () => {
	it('1. uses the fileName as given when it already has an extension', () => {
		assert.equal(
			deriveFileName({ fileName: 'shot.png', mimeType: 'image/jpeg' }, 'data'),
			'shot.png',
		);
	});

	it('2a. appends the fileExtension hint when the fileName has none', () => {
		assert.equal(deriveFileName({ fileName: 'shot', fileExtension: 'png' }, 'data'), 'shot.png');
	});

	it('2b. tolerates a leading dot on the fileExtension hint', () => {
		assert.equal(deriveFileName({ fileName: 'shot', fileExtension: '.png' }, 'data'), 'shot.png');
	});

	it('2c. derives the extension from the MIME type when there is no hint', () => {
		assert.equal(
			deriveFileName({ fileName: 'export', mimeType: 'text/csv' }, 'data'),
			'export.csv',
		);
	});

	it('3. uses the property name plus the extension when there is no fileName', () => {
		assert.equal(deriveFileName({ mimeType: 'application/pdf' }, 'invoice'), 'invoice.pdf');
	});

	it('4. keeps a bare fileName when nothing implies an extension', () => {
		assert.equal(deriveFileName({ fileName: 'notes' }, 'data'), 'notes');
	});

	it('5. falls all the way to <propName>.bin', () => {
		assert.equal(deriveFileName({}, 'data_3'), 'data_3.bin');
		assert.equal(deriveFileName({ mimeType: 'application/x-unknown' }, 'data'), 'data.bin');
	});

	it('prefers the fileExtension hint over the MIME type', () => {
		assert.equal(
			deriveFileName({ fileName: 'x', fileExtension: 'tsv', mimeType: 'text/csv' }, 'data'),
			'x.tsv',
		);
	});
});

describe('uniquifyFileName', () => {
	it('returns the name untouched when it is free', () => {
		assert.equal(uniquifyFileName('a.png', new Set()), 'a.png');
	});

	it('inserts the counter before the extension, not after the name', () => {
		assert.equal(uniquifyFileName('a.png', new Set(['a.png'])), 'a-2.png');
	});

	it('keeps counting past the first collision', () => {
		assert.equal(uniquifyFileName('a.png', new Set(['a.png', 'a-2.png'])), 'a-3.png');
	});

	it('handles a name with no extension', () => {
		assert.equal(uniquifyFileName('notes', new Set(['notes'])), 'notes-2');
	});

	it('preserves only the last extension', () => {
		assert.equal(uniquifyFileName('a.tar.gz', new Set(['a.tar.gz'])), 'a.tar-2.gz');
	});
});

describe('resolveFileName — derive, sanitize, uniquify', () => {
	it('does all three in one pass', () => {
		const used = new Set(['my_file.csv']);
		assert.equal(resolveFileName({ fileName: 'my file.csv' }, 'data', used), 'my_file-2.csv');
	});

	it('two unnamed properties of the same type do not collide', () => {
		const used = new Set<string>();
		const first = resolveFileName({ mimeType: 'image/png' }, 'data', used);
		used.add(first);
		const second = resolveFileName({ mimeType: 'image/png' }, 'data', used);
		assert.equal(first, 'data.png');
		assert.equal(second, 'data-2.png');
	});

	it('falls back to a sanitized property name when the fileName is unusable', () => {
		assert.equal(resolveFileName({ fileName: '///' }, 'my prop', new Set()), 'my_prop.bin');
	});

	it('never returns a path separator', () => {
		const name = resolveFileName({ fileName: '../../../etc/passwd' }, 'data', new Set());
		assert.equal(name.includes('/'), false);
		assert.equal(name.includes('\\'), false);
	});
});
