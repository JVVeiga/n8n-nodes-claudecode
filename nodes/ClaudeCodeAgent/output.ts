import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { IDataObject } from 'n8n-workflow';
import { buildDiagnostics, type DiagnosticsInput } from '../ClaudeCode/diagnostics';
import { resolveResultText } from '../ClaudeCode/output/resultText';
import { buildV12Output } from '../ClaudeCode/output/v12';
import { isResult, lastResult } from '../shared/sdkMessage';
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
	/** Replaces the metrics read from `messages` when a verification run added to them. */
	metrics?: IDataObject;
	verification?: IDataObject;
};

/**
 * The messages with every result but the last removed. Subagents run in the background by
 * default, so the CLI writes a result for the turn that launched them ("I'll wait for them") and
 * another for each turn their notifications start; the answer is the last one. The shared text
 * ladder reads the first result, which the Claude Code node's versions keep.
 */
export const withFinalResultOnly = (messages: SDKMessage[]): SDKMessage[] => {
	const final = lastResult(messages);
	return final ? messages.filter((m) => !isResult(m) || m === final) : messages;
};

export function buildAgentOutput(input: AgentOutputInput): IDataObject {
	const resolved = resolveResultText(withFinalResultOnly(input.messages));
	const envelope: IDataObject = {
		...buildV12Output({
			format: input.includeTranscript ? 'messages' : 'text',
			messages: input.messages,
			diagnostics: input.diagnostics,
			includeTranscript: input.includeTranscript,
			durationMs: input.durationMs,
		}),
		result: resolved.text,
		success: resolved.success,
		errorText: resolved.errorText,
	};
	if (input.metrics) envelope.metrics = input.metrics;
	return {
		...envelope,
		...(input.structured === undefined ? {} : { structured: input.structured as IDataObject }),
		...(input.verification ? { verification: input.verification } : {}),
	};
}
