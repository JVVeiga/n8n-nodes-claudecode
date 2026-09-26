import { createHash } from 'node:crypto';

export type FingerprintFields = {
	path: string;
	line: string;
	type: string;
	fingerprint: string;
};

/** A file as read at the ref, or why it could not be. */
export type FileRead = { text: string } | { error: string };

export type ReadFile = (path: string) => Promise<FileRead>;

/** Splits file text into lines; a final newline does not make an extra empty line. */
export function splitLines(text: string): string[] {
	const lines = text.split('\n');
	if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/**
 * The anchor line and `radius` lines either side (1-based, clamped at the file edges), each
 * trimmed with whitespace runs collapsed and blank lines dropped — so re-indenting or moving the
 * block does not change it, and editing its text does. Null when the line is outside the file.
 */
export function normalizeSnippet(lines: string[], line: number, radius: number): string | null {
	if (!Number.isInteger(line) || line < 1 || line > lines.length) return null;
	const r = Math.max(0, Math.floor(radius));
	const from = Math.max(0, line - 1 - r);
	const to = Math.min(lines.length, line + r);
	return lines
		.slice(from, to)
		.map((l) => l.trim().replace(/\s+/g, ' '))
		.filter((l) => l !== '')
		.join('\n');
}

export function fingerprint(path: string, type: string, snippet: string): string {
	return createHash('sha256').update(`${path}\0${type}\0${snippet}`).digest('hex');
}

const asType = (value: unknown): string =>
	typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);

/**
 * Adds the fingerprint to every item. One that cannot be fingerprinted keeps its place with
 * `fingerprint: null` and an `error` note — it is never dropped. Each file is read once.
 */
export async function fingerprintItems(
	items: unknown[],
	fields: FingerprintFields,
	radius: number,
	readFile: ReadFile,
): Promise<unknown[]> {
	const reads = new Map<string, Promise<FileRead>>();
	const out: unknown[] = [];

	for (const item of items) {
		if (item === null || typeof item !== 'object' || Array.isArray(item)) {
			out.push({
				value: item,
				[fields.fingerprint]: null,
				error: 'item is not an object',
			});
			continue;
		}
		const record = item as Record<string, unknown>;
		const fail = (error: string) => ({ ...record, [fields.fingerprint]: null, error });
		const path = record[fields.path];
		const line = record[fields.line];
		if (typeof path !== 'string' || path === '') {
			out.push(fail(`"${fields.path}" must be a non-empty string`));
			continue;
		}
		if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
			out.push(fail(`"${fields.line}" must be a positive integer`));
			continue;
		}

		let pending = reads.get(path);
		if (!pending) {
			pending = readFile(path);
			reads.set(path, pending);
		}
		const read = await pending;
		if ('error' in read) {
			out.push(fail(read.error));
			continue;
		}
		const lines = splitLines(read.text);
		const snippet = normalizeSnippet(lines, line, radius);
		if (snippet === null) {
			out.push(fail(`line ${line} is outside ${path} (${lines.length} lines)`));
			continue;
		}
		out.push({
			...record,
			[fields.fingerprint]: fingerprint(path, asType(record[fields.type]), snippet),
		});
	}
	return out;
}
