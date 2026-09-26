import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

/**
 * What a Subagent sub-node supplies and the Agent consumes. The tag is how the Agent tells a
 * subagent apart from anything else n8n lets a user wire into the same input.
 */
export const SUBAGENT_TAG = '__claudeCodeSubagent';

export type SuppliedSubagent = {
	[SUBAGENT_TAG]: 1;
	name: string;
	definition: AgentDefinition;
	log?: (invocation: SubagentInvocation) => void;
};

/** One delegation to a subagent, as the run reported it. Every field the CLI may omit is null. */
export type SubagentInvocation = {
	name: string;
	description: string | null;
	prompt: string | null;
	status: string | null;
	summary: string | null;
	totalTokens: number | null;
	toolUses: number | null;
	durationMs: number | null;
};

export const isSuppliedSubagent = (value: unknown): value is SuppliedSubagent => {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		v[SUBAGENT_TAG] === 1 &&
		typeof v.name === 'string' &&
		typeof v.definition === 'object' &&
		v.definition !== null
	);
};
