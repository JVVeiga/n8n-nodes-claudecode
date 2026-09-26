import { splitPath, valueAt } from './select';

export type Verdict = { keep: number[]; drop: Array<{ index: number; reason: string }> };

export type DroppedItem = { index: number; reason: string; item: unknown };

export type VerificationReport = {
	status: 'verified' | 'failed' | 'skipped';
	reason?: string;
	checked: number;
	kept: number;
	dropped: number;
	unjudged: number[];
	droppedItems: DroppedItem[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The verdict as the schema describes it, or null. Entries that are not integers are dropped. */
export function parseVerdict(raw: unknown): Verdict | null {
	if (!isRecord(raw) || !Array.isArray(raw.keep) || !Array.isArray(raw.drop)) return null;
	return {
		keep: raw.keep.filter((i): i is number => Number.isInteger(i)),
		drop: raw.drop
			.filter(isRecord)
			.filter((d) => Number.isInteger(d.index))
			.map((d) => ({ index: d.index as number, reason: String(d.reason ?? '') })),
	};
}

/** `structured` with the array at `segments` replaced; every object on the way is copied. */
function replaceAt(root: unknown, segments: string[], array: unknown[]): unknown {
	if (segments.length === 0) return array;
	const [head, ...rest] = segments;
	const record = isRecord(root) ? root : {};
	return { ...record, [head]: replaceAt(record[head], rest, array) };
}

/**
 * Removes what the verifier dropped from the checked items. An item it did not judge is kept, and
 * so is one it both kept and dropped: losing a true finding costs more than keeping a false one.
 */
export function applyVerdict(
	structured: unknown,
	itemsPath: string,
	indices: number[],
	verdict: Verdict,
): { structured: unknown; report: VerificationReport } {
	const segments = splitPath(itemsPath);
	const array = valueAt(structured, segments) as unknown[];
	const checked = new Set(indices);
	const kept = new Set(verdict.keep.filter((i) => checked.has(i)));

	const reasons = new Map<number, string>();
	for (const drop of verdict.drop) {
		if (checked.has(drop.index) && !kept.has(drop.index) && !reasons.has(drop.index)) {
			reasons.set(drop.index, drop.reason);
		}
	}

	const unjudged = indices.filter((i) => !kept.has(i) && !reasons.has(i));
	const droppedItems: DroppedItem[] = indices
		.filter((i) => reasons.has(i))
		.map((i) => ({ index: i, reason: reasons.get(i) as string, item: array[i] }));

	return {
		structured: replaceAt(
			structured,
			segments,
			array.filter((_, i) => !reasons.has(i)),
		),
		report: {
			status: 'verified',
			checked: indices.length,
			kept: indices.length - droppedItems.length,
			dropped: droppedItems.length,
			unjudged,
			droppedItems,
		},
	};
}

export const failedReport = (reason: string, checked: number): VerificationReport => ({
	status: 'failed',
	reason,
	checked,
	kept: checked,
	dropped: 0,
	unjudged: [],
	droppedItems: [],
});

export const skippedReport = (): VerificationReport => ({
	status: 'skipped',
	checked: 0,
	kept: 0,
	dropped: 0,
	unjudged: [],
	droppedItems: [],
});
