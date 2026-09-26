export type DedupeFields = {
	fingerprint: string;
	status: string;
	/** The status value that marks a previous item as still open. */
	openValue: string;
};

export type RepeatedItem = { item: unknown; previous: Record<string, unknown> };

export type DedupeResult = {
	new: unknown[];
	repeated: RepeatedItem[];
	resolved: unknown[];
};

const fingerprintOf = (item: unknown, field: string): string | null => {
	if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
	const value = (item as Record<string, unknown>)[field];
	return typeof value === 'string' && value !== '' ? value : null;
};

const isOpen = (item: Record<string, unknown>, fields: DedupeFields): boolean => {
	const status = item[fields.status];
	return status !== undefined && status !== null && String(status) === fields.openValue;
};

/**
 * `repeated` carries the previous item next to the new one, so its status and id (a posted
 * comment, a dismissal) travel with it. A previous item without a fingerprint is never resolved:
 * nothing shows it is gone.
 */
export function dedupe(
	newItems: unknown[],
	previousItems: unknown[],
	fields: DedupeFields,
): DedupeResult {
	const previousByFingerprint = new Map<string, Record<string, unknown>>();
	for (const previous of previousItems) {
		const fp = fingerprintOf(previous, fields.fingerprint);
		if (fp === null) continue;
		const record = previous as Record<string, unknown>;
		const existing = previousByFingerprint.get(fp);
		// With duplicates, the open one is the one a repeat should point at.
		if (!existing || (!isOpen(existing, fields) && isOpen(record, fields))) {
			previousByFingerprint.set(fp, record);
		}
	}

	const result: DedupeResult = { new: [], repeated: [], resolved: [] };
	const seen = new Set<string>();
	for (const item of newItems) {
		const fp = fingerprintOf(item, fields.fingerprint);
		if (fp !== null) seen.add(fp);
		const previous = fp === null ? undefined : previousByFingerprint.get(fp);
		if (previous) result.repeated.push({ item, previous });
		else result.new.push(item);
	}

	for (const previous of previousItems) {
		const fp = fingerprintOf(previous, fields.fingerprint);
		if (fp === null || seen.has(fp)) continue;
		if (isOpen(previous as Record<string, unknown>, fields)) result.resolved.push(previous);
	}
	return result;
}
