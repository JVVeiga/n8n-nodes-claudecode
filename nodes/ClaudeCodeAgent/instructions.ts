import * as fs from 'fs';
import * as path from 'path';
import type { Problem } from '../shared/problem';

export const MAX_INSTRUCTIONS_FILE_BYTES = 256 * 1024;

export type InstructionsIo = {
	realpathSync: (p: string) => string;
	statSync: (p: string) => { isFile(): boolean; size: number };
	readFileSync: (p: string, encoding: 'utf8') => string;
};

export type Instructions = { append: string | undefined; loaded: string[]; missing: string[] };

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
	const entries = files.map((f) => f.trim()).filter((f) => f !== '');
	if (entries.length === 0) return { append: undefined, loaded: [], missing: [] };

	if (projectPath.trim() === '') {
		return {
			problem: {
				message: 'Instruction Files are set but Project Path is empty.',
				description: 'Set a Project Path; Instruction Files are read relative to it.',
			},
		};
	}

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
		if (stat.size > MAX_INSTRUCTIONS_FILE_BYTES) {
			return {
				problem: {
					message:
						`Instruction file '${entry}' is ${stat.size} bytes, over the ` +
						`${MAX_INSTRUCTIONS_FILE_BYTES / 1024} KB limit.`,
					description: 'Split the file, or trim it to the instructions the agent needs.',
				},
			};
		}

		let content: string;
		try {
			content = io.readFileSync(target, 'utf8');
		} catch (error) {
			return unreadable(entry, error);
		}
		blocks.push(`<instructions file="${entry}">\n${content}\n</instructions>`);
		loaded.push(entry);
	}

	return { append: blocks.length ? blocks.join('\n\n') : undefined, loaded, missing };
}
