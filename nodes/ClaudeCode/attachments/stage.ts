import { randomBytes } from 'crypto';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Attachment, StagedAttachments } from './types';

/**
 * Writing the files a content block cannot carry.
 *
 * The only module here that touches a filesystem, and the only one that hands back something the
 * caller must undo. `os.tmpdir()` rather than a subdirectory of Project Path: the SDK spawns the
 * CLI in the same container as the node, so `tmpdir()` is reachable from both, and writing into the
 * user's project would leave debris inside a mounted volume the one time cleanup does not run.
 *
 * Injectable fs operations, because the interesting behaviour is what happens when a write fails
 * and that is not reproducible against a real disk.
 */

export type StageDeps = {
	mkdir?: (path: string) => void;
	writeFile?: (path: string, data: Buffer) => void;
	remove?: (path: string) => void;
	/** The parent directory to create the staging directory in. */
	tmpDir?: () => string;
};

const realDeps: Required<StageDeps> = {
	mkdir: (path) => mkdirSync(path, { recursive: true }),
	writeFile: (path, data) => writeFileSync(path, data),
	remove: (path) => rmSync(path, { recursive: true, force: true }),
	tmpDir: tmpdir,
};

export function stageAttachments(toStage: Attachment[], deps: StageDeps = {}): StagedAttachments {
	const { mkdir, writeFile, remove, tmpDir } = { ...realDeps, ...deps };

	const dir = join(tmpDir(), `n8n-claude-${randomBytes(8).toString('hex')}`);
	mkdir(dir);

	const fileNames: string[] = [];
	try {
		for (const attachment of toStage) {
			// Already sanitized and made item-unique by name.ts, so this cannot escape `dir` and
			// cannot collide with a sibling.
			writeFile(join(dir, attachment.fileName), attachment.buffer);
			fileNames.push(attachment.fileName);
		}
	} catch (error) {
		// Roll the whole directory back. Half-staged state would mean the hint block in the prompt
		// lists a file the model then fails to read, which reads to the model as a broken tool
		// rather than a broken request.
		remove(dir);
		throw error;
	}

	let cleaned = false;
	return {
		dir,
		fileNames,
		// Idempotent: it is called from a `finally` that can run after the rollback above already
		// removed the directory, and on a path where the item failed before staging finished.
		cleanup: () => {
			if (cleaned) return;
			cleaned = true;
			remove(dir);
		},
	};
}
