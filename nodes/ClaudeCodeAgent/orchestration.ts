/**
 * Appended to the user turn when every connected subagent must be used. It asks; it cannot force —
 * the subagent report is what shows whether the model complied.
 */
export function orchestrationInstruction(names: string[]): string | null {
	if (names.length === 0) return null;
	const list = names.map((n) => `- ${n}`).join('\n');
	return (
		'Before writing your final answer, delegate to EVERY one of these subagents, each at least ' +
		`once:\n${list}\n` +
		'Base your final answer on their results.'
	);
}
