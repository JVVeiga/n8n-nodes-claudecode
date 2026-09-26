import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { IDataObject } from 'n8n-workflow';
import { buildDiagnostics, type DiagnosticsInput } from '../ClaudeCode/diagnostics';
import { buildV12Output } from '../ClaudeCode/output/v12';
import { withFinalResultOnly } from '../shared/sdkMessage';
import type { SessionState } from '../shared/session';
import type { SubagentDiagnostics } from './subagentReport';

export type InstructionsDiagnostics = { loaded: string[]; missing: string[] };

export type StructuredOutputDiagnostics = { mode: string; attempts: number };

/** Each key is omitted, not null, when the run did not use the feature — the same conditional
 * spread as the shared `attachments` and `auth`, for the same reason. */
export type AgentDiagnosticsExtra = {
	subagents?: SubagentDiagnostics[];
	bridgedTools?: string[];
	instructions?: InstructionsDiagnostics;
	structuredOutput?: StructuredOutputDiagnostics;
	sessionState?: SessionState;
};

export type AgentDiagnosticsInput = DiagnosticsInput & { extra?: AgentDiagnosticsExtra };

/** The shared diagnostics, read from the final result, then the Agent's own fields. */
export function buildAgentDiagnostics(input: AgentDiagnosticsInput): Record<string, unknown> {
	const { extra, ...shared } = input;
	return {
		...buildDiagnostics({ ...shared, messages: withFinalResultOnly(input.messages) }),
		...(extra?.subagents ? { subagents: extra.subagents } : {}),
		...(extra?.bridgedTools ? { bridgedTools: extra.bridgedTools } : {}),
		...(extra?.instructions ? { instructions: extra.instructions } : {}),
		...(extra?.structuredOutput ? { structuredOutput: extra.structuredOutput } : {}),
		...(extra?.sessionState ? { sessionState: extra.sessionState } : {}),
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

export function buildAgentOutput(input: AgentOutputInput): IDataObject {
	const envelope: IDataObject = buildV12Output({
		format: input.includeTranscript ? 'messages' : 'text',
		messages: input.messages,
		diagnostics: input.diagnostics,
		includeTranscript: input.includeTranscript,
		durationMs: input.durationMs,
		finalResultOnly: true,
	});
	if (input.metrics) envelope.metrics = input.metrics;
	return {
		...envelope,
		...(input.structured === undefined ? {} : { structured: input.structured as IDataObject }),
		...(input.verification ? { verification: input.verification } : {}),
	};
}
