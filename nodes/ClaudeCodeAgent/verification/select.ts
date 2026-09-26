import type { Problem } from '../../shared/problem';

export type ItemFilter = { field: string; values: string[] };

export type Selection = { items: unknown[]; indices: number[] };

const describe = (value: unknown): string => {
	if (value === undefined) return 'nothing';
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'an array';
	if (typeof value === 'object') return 'an object';
	return `a ${typeof value}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export const splitPath = (itemsPath: string): string[] =>
	itemsPath
		.split('.')
		.map((segment) => segment.trim())
		.filter((segment) => segment !== '');

/** The value at a dot path, or undefined when any step is missing. */
export function valueAt(root: unknown, segments: string[]): unknown {
	let current = root;
	for (const segment of segments) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

const PATH_HINT =
	'Items Path is a dot path into the structured output, e.g. findings or review.inline_comments, and must name an array.';

export const EMPTY_PATH_PROBLEM: Problem = {
	message: 'Verification is enabled, but Items Path is empty',
	description: PATH_HINT,
};

/** What refuses a Verification setting before anything runs. */
export function checkVerification(
	verification: { itemsPath: string } | null,
	outputMode: string,
): Problem | null {
	if (!verification) return null;
	if (outputMode === 'text') {
		return {
			message: 'Verification needs structured output, but Output Mode is Text',
			description:
				'Set Output Mode to JSON Schema or Output Parser, so there are items to check, or turn Verification off.',
		};
	}
	return splitPath(verification.itemsPath).length === 0 ? EMPTY_PATH_PROBLEM : null;
}

const selectionProblem = (itemsPath: string, found: string): Problem => ({
	message: `Verification Items Path "${itemsPath}" does not point to an array: found ${found} there`,
	description: PATH_HINT,
});

/** The items Verification judges, with their positions in the original array. */
export function selectItems(
	structured: unknown,
	itemsPath: string,
	filter: ItemFilter | null,
): Selection | { problem: Problem } {
	const segments = splitPath(itemsPath);
	if (segments.length === 0) return { problem: EMPTY_PATH_PROBLEM };

	const array = valueAt(structured, segments);
	if (!Array.isArray(array)) return { problem: selectionProblem(itemsPath, describe(array)) };

	const wanted =
		filter && filter.values.length > 0 ? new Set(filter.values.map((v) => v.trim())) : null;
	const items: unknown[] = [];
	const indices: number[] = [];
	array.forEach((item, index) => {
		if (wanted && filter) {
			const value = isRecord(item) ? item[filter.field] : undefined;
			if (value === undefined || value === null || !wanted.has(String(value).trim())) return;
		}
		items.push(item);
		indices.push(index);
	});
	return { items, indices };
}
