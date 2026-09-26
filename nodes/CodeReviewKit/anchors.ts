import type { AddedLines } from './diff';

export type AnchorFields = { path: string; line: string };

export type MovedItem = { item: unknown; reason: string };

export type AnchorCheck = { valid: unknown[]; moved: MovedItem[] };

const describe = (value: unknown): string =>
	value === undefined ? 'nothing' : `${typeof value} ${JSON.stringify(value)}`;

/** Why an item cannot anchor to the RIGHT side of the diff, or null when it can. */
export function anchorProblem(
	item: unknown,
	addedLines: AddedLines,
	fields: AnchorFields,
): string | null {
	if (item === null || typeof item !== 'object' || Array.isArray(item)) {
		return `item is not an object (got ${describe(item)})`;
	}
	const record = item as Record<string, unknown>;
	const path = record[fields.path];
	const line = record[fields.line];
	if (typeof path !== 'string' || path === '') {
		return `"${fields.path}" must be a non-empty string (got ${describe(path)})`;
	}
	if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
		return `"${fields.line}" must be a positive integer (got ${describe(line)})`;
	}
	const lines = Object.prototype.hasOwnProperty.call(addedLines, path) ? addedLines[path] : null;
	if (!Array.isArray(lines)) return `file is not in the diff (or was deleted): ${path}`;
	if (!lines.includes(line)) return `line ${line} is not an added line in ${path}`;
	return null;
}

/** Nothing is discarded: every item lands in `valid` or in `moved` with its reason. */
export function validateAnchors(
	items: unknown[],
	addedLines: AddedLines,
	fields: AnchorFields,
): AnchorCheck {
	const valid: unknown[] = [];
	const moved: MovedItem[] = [];
	for (const item of items) {
		const reason = anchorProblem(item, addedLines, fields);
		if (reason === null) valid.push(item);
		else moved.push({ item, reason });
	}
	return { valid, moved };
}
