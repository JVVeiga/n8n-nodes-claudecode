import type { IDataObject } from 'n8n-workflow';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
	assistantMessages,
	contentOf,
	findInit,
	findResult,
	isUser,
} from '../../shared/sdkMessage';
import { resolveResultText } from './resultText';
import type { OutputFormat } from '../types';

/**
 * FROZEN. The output shapes of typeVersion 1 and 1.1.
 *
 * Every workflow already built on this node reads these exact fields. They are transcribed from
 * the pre-refactor execute() and held byte-for-byte by 48 golden fixtures in tests/fixtures/. Do
 * not tidy them, do not unify them, do not fix the quirks noted below — typeVersion 1.2 is where
 * that happens, in v12.ts, and this file is what proves 1.2 did not leak backwards.
 *
 * The quirks, deliberately preserved:
 *
 *  - `text` reports duration_ms 0 and total_cost_usd 0 when no result message arrived, which
 *    claims a run was instant and free when it was neither (F-01).
 *  - `messages` carries no metrics at all — not cost, not duration, not the session id (F-03).
 *  - `structured` counts a tool use only when it is the FIRST content block of an assistant
 *    message, so a message that says something before calling a tool is not counted (F-06).
 *  - The three formats derive `result` and `success` three different ways (C3).
 */

export type LegacyOutputInput = {
	format: OutputFormat;
	messages: SDKMessage[];
	diagnostics: Record<string, unknown> | null;
	includeTranscript: boolean;
};

type ResultLike = {
	subtype?: string;
	result?: unknown;
	errors?: string[];
	duration_ms?: number;
	num_turns?: number;
	total_cost_usd?: number;
	usage?: unknown;
	modelUsage?: unknown;
};

const resultOf = (messages: SDKMessage[]): ResultLike | undefined =>
	findResult(messages) as ResultLike | undefined;

function textOutput(input: LegacyOutputInput): IDataObject {
	const result = resultOf(input.messages);
	const resolved = resolveResultText(input.messages);
	return {
		// The String()/Number() coercions are load-bearing: n8n stores the item as JSON and a
		// non-serialisable value would be dropped silently.
		result: String(resolved.text || 'No response generated'),
		success: result?.subtype === 'success' ? true : false,
		duration_ms: Number(result?.duration_ms || 0),
		total_cost_usd: Number(result?.total_cost_usd || 0),
		diagnostics: input.diagnostics,
	} as IDataObject;
}

function messagesOutput(input: LegacyOutputInput): IDataObject {
	return {
		...(input.includeTranscript ? { messages: input.messages } : {}),
		messageCount: input.messages.length,
		diagnostics: input.diagnostics,
	} as IDataObject;
}

function structuredOutput(input: LegacyOutputInput): IDataObject {
	const { messages } = input;
	const result = resultOf(messages);
	const init = findInit(messages);

	// Only the first content block is inspected — see F-06. `contentOf(m)[0]` reproduces the
	// original `m.message?.content?.[0]?.type` exactly, including on a message with no content.
	const toolUses = assistantMessages(messages).filter((m) => contentOf(m)[0]?.type === 'tool_use');

	return {
		...(input.includeTranscript ? { messages } : {}),
		summary: {
			userMessageCount: messages.filter(isUser).length,
			assistantMessageCount: assistantMessages(messages).length,
			toolUseCount: toolUses.length,
			hasResult: !!result,
			toolsAvailable: init?.tools || [],
		},
		result: result?.result || (result?.errors?.length ? result.errors.join('; ') : null),
		metrics: result
			? {
					duration_ms: result.duration_ms,
					num_turns: result.num_turns,
					total_cost_usd: result.total_cost_usd,
					usage: result.usage,
					modelUsage: result.modelUsage,
				}
			: null,
		success: result?.subtype === 'success',
		diagnostics: input.diagnostics,
	} as IDataObject;
}

const BUILDERS: Record<OutputFormat, (input: LegacyOutputInput) => IDataObject> = {
	text: textOutput,
	messages: messagesOutput,
	structured: structuredOutput,
};

export function buildLegacyOutput(input: LegacyOutputInput): IDataObject {
	return BUILDERS[input.format](input);
}
