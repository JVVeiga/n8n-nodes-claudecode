/** Narrowing for values read from the CLI, a parser or a model's JSON, where any field may be absent. */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);

/** The sum of the figures that are present; null when none is. */
export const sum = (values: Array<number | null>): number | null => {
	const present = values.filter((v): v is number => v !== null);
	return present.length ? present.reduce((a, b) => a + b, 0) : null;
};
