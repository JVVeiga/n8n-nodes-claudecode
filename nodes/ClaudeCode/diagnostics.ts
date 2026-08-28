import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { countContent, countToolUses, findInit, findResult } from '../shared/sdkMessage';
import type { AttachmentDiagnostics } from './attachments/types';
import { effectiveEffort, isUltracode } from './params';
import type { ClaudeCodeParams } from './types';

/**
 * Verifiable proof of what actually ran.
 *
 * Every field answers a question a workflow author cannot otherwise answer: which model the CLI
 * really resolved to, what effort it applied after its own downgrades, whether Ultracode
 * orchestration actually fired. Built from whatever messages arrived, so the failure and timeout
 * paths can report it too — a run that died still has to say what it was doing.
 */

export type Diagnostics = {
	requestedModel: string;
	resolvedModel: string | null;
	modelsUsed: string[];
	fallbackModelRequested: string | null;
	requestedEffort: string;
	effectiveEffort: string;
	appliedEffort: string | null;
	permissionMode: string;
	sessionId: string | null;
	ultracodeRequested: boolean;
	workflowToolAvailable: boolean;
	workflowToolUses: number;
	subagentToolUses: number;
	thinkingRequested: string;
	thinkingBlocks: number;
	/**
	 * What was sent with the prompt, and how. Present ONLY when at least one attachment was
	 * processed — omitted, not null, when there were none.
	 *
	 * That distinction is load-bearing: `JSON.stringify` drops an `undefined` field entirely, so a
	 * run without attachments serialises to exactly the bytes it did before this feature existed,
	 * and all 48 golden fixtures for typeVersions 1 and 1.1 still hold. It is what let this ship
	 * without a new typeVersion.
	 */
	attachments?: AttachmentDiagnostics;
};

export type DiagnosticsInput = {
	messages: SDKMessage[];
	params: ClaudeCodeParams;
	/** The permission mode actually put on the SDK options, after the default is applied. */
	permissionMode: string;
	/** The effort Claude Code reported applying, captured from hooks. Null when none fired. */
	appliedEffort: string | null;
	/** The attachment report from `plan.ts`, with the staged directory filled in. Null when the
	 * run had no attachments — which is what keeps the key out of the output entirely. */
	attachments?: AttachmentDiagnostics | null;
};

export function buildDiagnostics(input: DiagnosticsInput): Diagnostics {
	const { messages, params, permissionMode, appliedEffort, attachments } = input;
	const init = findInit(messages);
	const result = findResult(messages);

	return {
		requestedModel: params.model,
		resolvedModel: init?.model ?? null,
		// Per-model spend, the only post-hoc record of which models ran. The init message reports
		// the model chosen at session start, so it does not reflect a mid-run switch to the
		// fallback — modelUsage does.
		modelsUsed: Object.keys(result?.modelUsage ?? {}),
		fallbackModelRequested: params.additional.fallbackModel || null,
		requestedEffort: params.effort,
		effectiveEffort: effectiveEffort(params),
		appliedEffort: appliedEffort ?? null,
		permissionMode,
		sessionId: result?.session_id ?? init?.session_id ?? null,
		ultracodeRequested: isUltracode(params),
		// Whether the CLI loaded the Workflow tool for this run. Allowed Tools cannot gate this: it
		// is the SDK's auto-approve list, not a restriction. Disallowed Tools does remove tools from
		// the model's context, so the init list already accounts for it.
		workflowToolAvailable: (init?.tools ?? []).includes('Workflow'),
		workflowToolUses: countToolUses(messages, 'Workflow'),
		subagentToolUses: countToolUses(messages, 'Task'),
		thinkingRequested: params.additional.thinking || 'default',
		thinkingBlocks: countContent(messages, (c) => c.type === 'thinking'),
		// Spread rather than assign: `attachments: undefined` would still be an own property, and
		// `JSON.stringify` dropping it is not the same as it never being there — a deep-equal
		// assertion in the golden fixture tests sees the difference.
		...(attachments ? { attachments } : {}),
	};
}
