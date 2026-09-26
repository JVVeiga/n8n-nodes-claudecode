export const DEFAULT_VERIFIER_INSTRUCTIONS = [
	'Verify each item below before anyone acts on it.',
	'Try to refute it with evidence from the repository: open and read the code it refers to, do not rely on memory or on your earlier answer.',
	'Keep only the items that survive that check.',
	'For every item you drop, give the concrete reason — what the code actually shows.',
].join(' ');

export const VERDICT_SCHEMA = {
	type: 'object',
	properties: {
		keep: { type: 'array', items: { type: 'integer' } },
		drop: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					index: { type: 'integer' },
					reason: { type: 'string' },
				},
				required: ['index', 'reason'],
			},
		},
	},
	required: ['keep', 'drop'],
};

/** The user turn of the verification run. */
export function verifierTurn(instructions: string, items: unknown[], indices: number[]): string {
	const listed = items.map((item, i) => ({ index: indices[i], item }));
	return [
		instructions.trim(),
		`Items to verify (${listed.length}), each with its index:`,
		JSON.stringify(listed, null, 2),
		'Return `keep` with the indices of the items that survive and `drop` with one entry per refuted item: its index and the concrete reason. Use only the indices listed above, and judge every one of them.',
	].join('\n\n');
}
