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

const UNATTENDED =
	'This run is unattended: nobody reads this conversation or answers questions. Make the ' +
	'decisions yourself and deliver the result; never end with a question or a list of options.';

const DELIVER_ONCE =
	'Deliver the structured output once, after every subagent you started has reported back. A ' +
	'rejected delivery comes back with the validator’s reason: fix what it names and send it again.';

/** The last text of the user turn. Per request, so the user turn rather than the system prompt. */
export function unattendedInstruction(run: { structured: boolean; subagents: boolean }): string {
	return run.structured && run.subagents ? `${UNATTENDED} ${DELIVER_ONCE}` : UNATTENDED;
}
