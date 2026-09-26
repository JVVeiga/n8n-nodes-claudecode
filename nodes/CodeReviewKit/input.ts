import type { Problem } from '../shared/problem';
import type { AddedLines } from './diff';

export type Parsed<T> = { value: T } | { problem: Problem };

/** A `json` parameter arrives as text when typed, and already parsed when set by an expression. */
function parse(value: unknown, label: string, example: string): Parsed<unknown> {
	if (typeof value !== 'string') return { value };
	const text = value.trim();
	if (text === '') return { value: undefined };
	try {
		return { value: JSON.parse(text) };
	} catch (error) {
		return {
			problem: {
				message: `${label} is not valid JSON: ${(error as Error).message}`,
				description: `Pass ${example}.`,
			},
		};
	}
}

export function parseItemsParam(value: unknown, label: string): Parsed<unknown[]> {
	const example = 'a JSON array of objects, e.g. {{ $json.findings }}';
	const parsed = parse(value, label, example);
	if ('problem' in parsed) return parsed;
	if (parsed.value === undefined || parsed.value === null) return { value: [] };
	if (!Array.isArray(parsed.value)) {
		return {
			problem: {
				message: `${label} must be a JSON array, got ${typeof parsed.value}`,
				description: `Pass ${example}. If the array sits inside an object, point the expression at it.`,
			},
		};
	}
	return { value: parsed.value };
}

export function parseAddedLinesParam(value: unknown): Parsed<AddedLines> {
	const example =
		'the addedLines object from Diff Context, e.g. {{ $json.addedLines }} — { "src/a.ts": [3, 4] }';
	const parsed = parse(value, 'Added Lines', example);
	if ('problem' in parsed) return parsed;
	if (parsed.value === undefined || parsed.value === null) return { value: {} };
	const record = parsed.value as Record<string, unknown>;
	const wrongShape =
		typeof record !== 'object' ||
		Array.isArray(record) ||
		Object.values(record).some((lines) => !Array.isArray(lines));
	if (wrongShape) {
		return {
			problem: {
				message: 'Added Lines must map each file path to an array of line numbers',
				description: `Pass ${example}.`,
			},
		};
	}
	return { value: record as AddedLines };
}
