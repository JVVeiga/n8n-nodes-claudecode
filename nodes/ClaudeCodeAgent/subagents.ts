import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { Problem } from '../shared/problem';
import { isSuppliedSubagent, type SuppliedSubagent } from '../shared/subagent';

/** `agents` holds the enabled subagents only; `supplied` every connected one. */
export type Subagents = { agents: Record<string, AgentDefinition>; supplied: SuppliedSubagent[] };

export const isEnabled = (s: SuppliedSubagent): boolean => s.enabled !== false;

/** The enabled subagents whose tools exclude Read: they cannot open a staged file. */
export const subagentsWithoutRead = (supplied: SuppliedSubagent[]): string[] =>
	supplied
		.filter(isEnabled)
		.filter(({ definition }) =>
			definition.tools
				? !definition.tools.includes('Read')
				: (definition.disallowedTools ?? []).includes('Read'),
		)
		.map((s) => s.name);

const describeValue = (value: unknown): string => {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'an array';
	if (typeof value !== 'object') return `a ${typeof value}`;
	const keys = Object.keys(value);
	return keys.length ? `an object with keys ${keys.join(', ')}` : 'an empty object';
};

/**
 * Turns what n8n delivers on the Subagents input into the SDK's `agents` record. Sorted by name
 * because n8n does not deliver connections in the order they were drawn, and the record's order
 * is what the model sees. A disabled subagent is validated like the rest but left out of the
 * record, so the model never learns it exists.
 */
export function buildSubagents(raw: unknown): Subagents | { problem: Problem } {
	const delivered = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];

	const supplied: SuppliedSubagent[] = [];
	for (const value of delivered) {
		if (!isSuppliedSubagent(value)) {
			return {
				problem: {
					message: `The Subagents input received something that is not a subagent: ${describeValue(value)}.`,
					description:
						'Only Claude Code Subagent nodes can be connected to the Subagents input. ' +
						'Remove any other node connected there.',
				},
			};
		}
		supplied.push(value);
	}

	const counts = new Map<string, number>();
	for (const s of supplied) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
	const duplicates = [...counts].filter(([, n]) => n > 1).map(([name]) => name);
	if (duplicates.length) {
		const quoted = duplicates
			.sort()
			.map((n) => `'${n}'`)
			.join(', ');
		return {
			problem: {
				message: `More than one connected subagent is named ${quoted}.`,
				description:
					'Each Claude Code Subagent connected to the same Agent needs a unique Name. ' +
					'Rename the duplicates.',
			},
		};
	}

	supplied.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const agents: Record<string, AgentDefinition> = {};
	for (const s of supplied.filter(isEnabled)) agents[s.name] = s.definition;
	return { agents, supplied };
}
