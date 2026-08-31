import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { assistantMessages, findInit } from '../shared/sdkMessage';
import { resolveResultText } from '../ClaudeCode/output/resultText';
import { collectRunMetrics } from '../ClaudeCode/timeout';
import { bridgedToolName, FORMAT_TOOL_NAME } from './toolBridge';

/**
 * What one run means to LangChain: the answer text, the usage numbers, and — exactly one case —
 * a tool call handed back to the Agent instead of being executed here.
 *
 * That case is n8n's "Require Specific Output Format" (spec F-15/R16): the Agent binds a
 * `format_final_json_response` tool and its parser treats a call to it as the final, structured
 * answer. The bridge executes the call in-process like any other (its `func` returns an empty
 * string, so that is harmless); this module then finds it in the transcript and returns it as a
 * real `tool_calls` entry under its ORIGINAL name, which is the name the Agent's parser matches.
 */

export type ChatToolCall = { id: string; name: string; args: Record<string, unknown> };

export type ChatOutcome = {
	text: string;
	/** Empty except for the structured-output passthrough described above. */
	toolCalls: ChatToolCall[];
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
	} | null;
	totalCostUsd: number | null;
	sessionId: string | null;
	numTurns: number | null;
	/** The model the session actually resolved to, from the init message. */
	model: string | null;
};

/** Content blocks, read structurally: `shared/sdkMessage.ts`'s ContentBlock deliberately omits
 * the tool_use fields nothing else needs. */
type ToolUseBlock = { type?: string; name?: string; id?: string; input?: unknown };

const BRIDGED_FORMAT_TOOL = bridgedToolName(FORMAT_TOOL_NAME);

/** The LAST format call wins: if the model corrected itself and called again, the correction is
 * the answer. */
function findFormatToolCall(messages: SDKMessage[]): ChatToolCall | null {
	let found: ChatToolCall | null = null;
	for (const message of assistantMessages(messages)) {
		const content = message.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content as ToolUseBlock[]) {
			if (block.type === 'tool_use' && block.name === BRIDGED_FORMAT_TOOL) {
				found = {
					id: block.id ?? `${FORMAT_TOOL_NAME}_call`,
					name: FORMAT_TOOL_NAME,
					args: (block.input ?? {}) as Record<string, unknown>,
				};
			}
		}
	}
	return found;
}

export function resolveChatOutcome(messages: SDKMessage[]): ChatOutcome {
	const metrics = collectRunMetrics(messages);
	const formatCall = findFormatToolCall(messages);

	return {
		// When the format tool was called, its arguments ARE the answer and the parser ignores the
		// text — but the text still travels as content for the log.
		text: resolveResultText(messages).text,
		toolCalls: formatCall ? [formatCall] : [],
		usage: metrics.usage,
		totalCostUsd: metrics.totalCostUsd,
		sessionId: metrics.sessionId,
		numTurns: metrics.numTurns,
		model: (findInit(messages) as { model?: string } | undefined)?.model ?? null,
	};
}
