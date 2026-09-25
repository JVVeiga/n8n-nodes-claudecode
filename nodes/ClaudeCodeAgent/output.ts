import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { IDataObject } from 'n8n-workflow';
import { buildDiagnostics, type DiagnosticsInput } from '../ClaudeCode/diagnostics';
import { buildV12Output } from '../ClaudeCode/output/v12';
import { countSubagentToolUses } from './subagentReport';

/** The shared diagnostics, with subagent delegations counted under both of their tool names. */
export function buildAgentDiagnostics(input: DiagnosticsInput): Record<string, unknown> {
	return {
		...buildDiagnostics(input),
		subagentToolUses: countSubagentToolUses(input.messages),
	};
}

export type AgentOutputInput = {
	messages: SDKMessage[];
	diagnostics: Record<string, unknown>;
	durationMs: number;
	includeTranscript: boolean;
	/** The validated object, when the run was asked for one. */
	structured?: unknown;
};

export function buildAgentOutput(input: AgentOutputInput): IDataObject {
	const envelope = buildV12Output({
		format: input.includeTranscript ? 'messages' : 'text',
		messages: input.messages,
		diagnostics: input.diagnostics,
		includeTranscript: input.includeTranscript,
		durationMs: input.durationMs,
	});
	return input.structured === undefined
		? envelope
		: { ...envelope, structured: input.structured as IDataObject };
}
