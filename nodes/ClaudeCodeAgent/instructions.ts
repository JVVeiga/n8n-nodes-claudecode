import * as fs from 'fs';
import * as path from 'path';
import type { RefReader } from '../shared/git';
import { checkRef } from '../shared/gitRefs';
import type { Problem } from '../shared/problem';

export const MAX_INSTRUCTIONS_FILE_BYTES = 256 * 1024;

export type InstructionsIo = {
	realpathSync: (p: string) => string;
	statSync: (p: string) => { isFile(): boolean; size: number };
	readFileSync: (p: string, encoding: 'utf8') => string;
};

export type Instructions = {
	append: string | undefined;
	loaded: string[];
	missing: string[];
	/** Set only when the files were read at a git ref. */
	ref?: string;
};

export const INSTRUCTIONS_REF_LABEL = 'Read Instruction Files From Ref';

const nodeIo: InstructionsIo = {
	realpathSync: (p) => fs.realpathSync(p),
	statSync: (p) => fs.statSync(p),
	readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
};

const isInside = (root: string, target: string): boolean => {
	const rel = path.relative(root, target);
	return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

const isNotFound = (error: unknown): boolean =>
	typeof error === 'object' &&
	error !== null &&
	((error as NodeJS.ErrnoException).code === 'ENOENT' ||
		(error as NodeJS.ErrnoException).code === 'ENOTDIR');

const unreadable = (entry: string, error: unknown): { problem: Problem } => ({
	problem: {
		message: `Instruction file '${entry}' could not be read: ${
			error instanceof Error ? error.message : String(error)
		}`,
		description: 'Check that the file is readable by the n8n process.',
	},
});

const outside = (entry: string): { problem: Problem } => ({
	problem: {
		message: `Instruction file '${entry}' resolves outside the Project Path.`,
		description:
			'Instruction Files are read only from inside the Project Path. Use a path relative to ' +
			'it, without "..", and not a link that points elsewhere.',
	},
});

const entriesOf = (files: string[]): string[] => files.map((f) => f.trim()).filter((f) => f !== '');

const NO_PROJECT_PATH: { problem: Problem } = {
	problem: {
		message: 'Instruction Files are set but Project Path is empty.',
		description: 'Set a Project Path; Instruction Files are read relative to it.',
	},
};

const overCap = (entry: string, size: number): { problem: Problem } => ({
	problem: {
		message:
			`Instruction file '${entry}' is ${size} bytes, over the ` +
			`${MAX_INSTRUCTIONS_FILE_BYTES / 1024} KB limit.`,
		description: 'Split the file, or trim it to the instructions the agent needs.',
	},
});

const block = (entry: string, content: string): string =>
	`<instructions file="${entry}">\n${content}\n</instructions>`;

const joined = (blocks: string[]): string | undefined =>
	blocks.length ? blocks.join('\n\n') : undefined;

/** Working tree when `ref` is empty; otherwise git at that ref. The one place that decides. */
export async function loadInstructions(
	projectPath: string,
	files: string[],
	ref: string,
	openRef: (projectPath: string) => RefReader,
	io: InstructionsIo = nodeIo,
): Promise<Instructions | { problem: Problem }> {
	if (ref === '') return readInstructions(projectPath, files, io);
	return readInstructionsAtRef(projectPath, files, ref, openRef);
}

/** A path inside the ref, relative to Project Path; null when it would leave it. */
const atRefPath = (entry: string): string | null => {
	if (path.posix.isAbsolute(entry) || path.win32.isAbsolute(entry)) return null;
	const normal = path.posix.normalize(entry);
	return normal === '..' || normal.startsWith('../') ? null : normal;
};

/**
 * The same rules as the working tree, read with git: a path absent at the ref is missing, one
 * leaving the Project Path or over the cap is fatal, and a bad or unknown ref fails before any run.
 */
export async function readInstructionsAtRef(
	projectPath: string,
	files: string[],
	ref: string,
	openRef: (projectPath: string) => RefReader,
): Promise<Instructions | { problem: Problem }> {
	const entries = entriesOf(files);
	if (entries.length === 0) return { append: undefined, loaded: [], missing: [] };
	if (projectPath.trim() === '') return NO_PROJECT_PATH;
	const refProblem = checkRef(ref, INSTRUCTIONS_REF_LABEL);
	if (refProblem) return { problem: refProblem };
	// The shared check lets a range through (the Kit's git reports it); one file needs one tree.
	if (ref.includes('..')) {
		return {
			problem: {
				message: `${INSTRUCTIONS_REF_LABEL} is a range, not a single ref: ${JSON.stringify(ref)}`,
				description: 'Give one branch, tag or commit SHA, e.g. origin/main.',
			},
		};
	}

	const targets: Array<[string, string]> = [];
	for (const entry of entries) {
		const target = atRefPath(entry);
		if (target === null) return outside(entry);
		targets.push([entry, target]);
	}

	const reader = openRef(path.resolve(projectPath));
	const blocks: string[] = [];
	const loaded: string[] = [];
	const missing: string[] = [];

	for (const [entry, target] of targets) {
		const read = await reader.fileAt(ref, target);
		if ('ok' in read) {
			const size = Buffer.byteLength(read.ok, 'utf8');
			if (size > MAX_INSTRUCTIONS_FILE_BYTES) return overCap(entry, size);
			blocks.push(block(entry, read.ok));
			loaded.push(entry);
			continue;
		}
		if (read.unreadable === 'absent') {
			missing.push(entry);
			continue;
		}
		if (read.unreadable === 'notFile') {
			return {
				problem: {
					message: `Instruction file '${entry}' is not a file at ${ref}.`,
					description: 'List files, not directories or symbolic links, under Instruction Files.',
				},
			};
		}
		if (read.unreadable === 'tooLarge') {
			return {
				problem: {
					message: `Instruction file '${entry}' is over the ${MAX_INSTRUCTIONS_FILE_BYTES / 1024} KB limit at ${ref}.`,
					description: 'Split the file, or trim it to the instructions the agent needs.',
				},
			};
		}
		return {
			problem: {
				message: `Instruction Files could not be read at ${ref}: ${read.problem.message}`,
				description:
					read.problem.description ??
					'Check that Project Path is inside a git clone that contains this ref.',
			},
		};
	}

	return { append: joined(blocks), loaded, missing, ref };
}

/**
 * Reads the Instruction Files into one block for the system prompt's `append`. A missing file is
 * reported, not fatal — the same list is meant to work across repositories that may lack it. A
 * path leaving the Project Path is fatal, because silently skipping it would hide the attempt.
 */
export function readInstructions(
	projectPath: string,
	files: string[],
	io: InstructionsIo = nodeIo,
): Instructions | { problem: Problem } {
	const entries = entriesOf(files);
	if (entries.length === 0) return { append: undefined, loaded: [], missing: [] };
	if (projectPath.trim() === '') return NO_PROJECT_PATH;

	const root = path.resolve(projectPath);
	let realRoot: string;
	try {
		realRoot = io.realpathSync(root);
	} catch {
		return {
			problem: {
				message: `The Project Path '${projectPath}' does not exist, so no Instruction File can be read.`,
				description: 'Check the Project Path.',
			},
		};
	}

	const blocks: string[] = [];
	const loaded: string[] = [];
	const missing: string[] = [];

	for (const entry of entries) {
		const target = path.resolve(root, entry);
		if (!isInside(root, target)) return outside(entry);

		let stat: { isFile(): boolean; size: number };
		try {
			stat = io.statSync(target);
		} catch (error) {
			if (isNotFound(error)) {
				missing.push(entry);
				continue;
			}
			return unreadable(entry, error);
		}

		let realTarget: string;
		try {
			realTarget = io.realpathSync(target);
		} catch (error) {
			return unreadable(entry, error);
		}
		if (!isInside(realRoot, realTarget)) return outside(entry);

		if (!stat.isFile()) {
			return {
				problem: {
					message: `Instruction file '${entry}' is not a file.`,
					description: 'List files, not directories, under Instruction Files.',
				},
			};
		}
		if (stat.size > MAX_INSTRUCTIONS_FILE_BYTES) return overCap(entry, stat.size);

		let content: string;
		try {
			content = io.readFileSync(target, 'utf8');
		} catch (error) {
			return unreadable(entry, error);
		}
		blocks.push(block(entry, content));
		loaded.push(entry);
	}

	return { append: joined(blocks), loaded, missing };
}
