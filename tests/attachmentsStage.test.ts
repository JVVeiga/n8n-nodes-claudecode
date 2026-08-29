import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { stageAttachments, type StageDeps } from '../nodes/ClaudeCode/attachments/stage';
import type { Attachment } from '../nodes/ClaudeCode/attachments/types';

const attachment = (fileName: string, content: string | Buffer): Attachment => {
	const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
	return { propName: 'data', fileName, mimeType: 'text/plain', bytes: buffer.length, buffer };
};

/**
 * Real filesystem, with the directory removed whatever happens. A failing assertion must not leave
 * anything in /tmp — the test suite runs on the maintainer's machine, not in a container.
 */
const withStaged = (
	attachments: Attachment[],
	body: (staged: ReturnType<typeof stageAttachments>) => void,
): void => {
	const staged = stageAttachments(attachments);
	try {
		body(staged);
	} finally {
		staged.cleanup();
	}
};

describe('stageAttachments — writing', () => {
	it('writes each file with its given name and exact bytes', () => {
		withStaged([attachment('a.csv', 'sku,qty\n'), attachment('b.txt', 'hello')], (staged) => {
			assert.deepEqual(staged.fileNames, ['a.csv', 'b.txt']);
			assert.equal(readFileSync(join(staged.dir, 'a.csv'), 'utf8'), 'sku,qty\n');
			assert.equal(readFileSync(join(staged.dir, 'b.txt'), 'utf8'), 'hello');
		});
	});

	it('round-trips binary bytes without corruption', () => {
		const bytes = Buffer.from([0x89, 0x50, 0x00, 0xff, 0xfe]);
		withStaged([attachment('s.png', bytes)], (staged) => {
			assert.ok(readFileSync(join(staged.dir, 's.png')).equals(bytes));
		});
	});

	it('creates the directory under os.tmpdir(), not in the project', () => {
		withStaged([attachment('a.txt', 'x')], (staged) => {
			assert.ok(staged.dir.startsWith(tmpdir()), staged.dir);
			assert.match(staged.dir, /n8n-claude-[0-9a-f]{16}$/);
		});
	});

	it('gives two calls different directories, so concurrent items cannot collide', () => {
		withStaged([attachment('a.txt', 'x')], (first) => {
			withStaged([attachment('a.txt', 'y')], (second) => {
				assert.notEqual(first.dir, second.dir);
				assert.equal(readFileSync(join(first.dir, 'a.txt'), 'utf8'), 'x');
			});
		});
	});

	it('writes nothing but the directory when there is nothing to stage', () => {
		withStaged([], (staged) => {
			assert.deepEqual(readdirSync(staged.dir), []);
			assert.deepEqual(staged.fileNames, []);
		});
	});
});

describe('stageAttachments — cleanup', () => {
	it('removes the directory and its contents', () => {
		const staged = stageAttachments([attachment('a.txt', 'x')]);
		assert.ok(existsSync(staged.dir));
		staged.cleanup();
		assert.equal(existsSync(staged.dir), false);
	});

	it('is idempotent — the node calls it from a finally that can run after a rollback', () => {
		const staged = stageAttachments([attachment('a.txt', 'x')]);
		staged.cleanup();
		staged.cleanup();
		assert.equal(existsSync(staged.dir), false);
	});

	it('only removes once, even under the injected deps', () => {
		const removed: string[] = [];
		const deps: StageDeps = {
			mkdir: () => {},
			writeFile: () => {},
			remove: (path) => removed.push(path),
			tmpDir: () => '/fake',
		};
		const staged = stageAttachments([attachment('a.txt', 'x')], deps);
		staged.cleanup();
		staged.cleanup();
		assert.deepEqual(removed, [staged.dir]);
	});
});

describe('stageAttachments — rollback', () => {
	it('removes the whole directory when a write fails, and rethrows', () => {
		const removed: string[] = [];
		const written: string[] = [];
		const deps: StageDeps = {
			mkdir: () => {},
			writeFile: (path) => {
				written.push(path);
				if (written.length === 2) throw new Error('ENOSPC');
			},
			remove: (path) => removed.push(path),
			tmpDir: () => '/fake',
		};

		assert.throws(
			() => stageAttachments([attachment('a.txt', 'x'), attachment('b.txt', 'y')], deps),
			/ENOSPC/,
		);
		// One directory removed, and it is the one the first write went into.
		assert.equal(removed.length, 1);
		assert.ok(written[0].startsWith(removed[0]));
	});

	it('leaves no directory behind on a real filesystem failure', () => {
		let dir = '';
		assert.throws(() =>
			stageAttachments([attachment('a.txt', 'x')], {
				mkdir: (path) => {
					dir = path;
					// Created for real, so the rollback has something to remove and the assertion
					// below is about the filesystem rather than about a spy.
					mkdirSync(path, { recursive: true });
				},
				writeFile: () => {
					throw new Error('boom');
				},
			}),
		);
		assert.notEqual(dir, '');
		assert.equal(existsSync(dir), false);
	});
});
