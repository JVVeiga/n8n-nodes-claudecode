import type { IDataObject } from 'n8n-workflow';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
	assistantMessages,
	countContent,
	findInit,
	isUser,
	lastResult,
} from '../../shared/sdkMessage';
import { resolveResultText } from './resultText';
import type { OutputFormat } from '../types';

/**
 * typeVersion 1.2: one envelope, three views of it.
 *
 * The legacy formats each built their own shape, deriving `result`, `success` and the metrics three
 * different ways (C3). Adding a field meant remembering three places, and the three could — and did
 * — disagree about the same run. Here `outputFormat` chooses which optional SECTIONS are present,
 * never which shape is built.
 *
 *   { result, success, errorText, metrics{…}, diagnostics, messages?, summary? }
 *
 *   text        result + success + errorText + metrics + diagnostics
 *   messages    …plus the transcript
 *   structured  …plus the transcript and the summary
 *
 * Four legacy findings are fixed here, and nowhere else:
 *
 *   F-01  an unknown cost reports `null`, not `0`. A run that produced no result message may well
 *         have spent money, and claiming zero is a fabricated number.
 *   F-03  every format carries metrics, including `messages`. Wanting the transcript no longer
 *         means running the node twice to learn what it cost.
 *   F-06  a tool use counts wherever it appears in a turn, not only as the first content block.
 *   F-07  the metrics come from the LAST result message. On a graceful timeout the first is the
 *         interrupt's own per-turn count; the last is the cumulative one.
 *
 * `errorText` is also new: the legacy text format folded error prose into `result`, so a caller
 * could not tell a recovered partial answer from a real failure without string-matching.
 */

export type V12Input = {
	format: OutputFormat;
	messages: SDKMessage[];
	diagnostics: Record<string, unknown> | null;
	includeTranscript: boolean;
	/** Wall time measured by the runner. Used when the SDK reported no duration of its own. */
	durationMs: number;
};

type ResultLike = {
	subtype?: string;
	duration_ms?: number;
	num_turns?: number;
	total_cost_usd?: number;
	usage?: unknown;
	modelUsage?: unknown;
	session_id?: string;
};

/** A number the SDK actually reported, or null. Never a zero standing in for "unknown". */
const reported = (value: number | undefined): number | null =>
	typeof value === 'number' ? value : null;

export function buildV12Output(input: V12Input): IDataObject {
	const { messages } = input;
	// The LAST result, not the first — see F-07.
	const result = lastResult(messages) as ResultLike | undefined;
	const resolved = resolveResultText(messages);

	const envelope: IDataObject = {
		result: resolved.text,
		success: resolved.success,
		// Empty string rather than null when the run did not fail, so the field's type is stable.
		errorText: resolved.errorText,
		metrics: {
			// The SDK's own duration when it reported one, otherwise the wall time we measured. Both
			// are real; neither is invented.
			duration_ms: reported(result?.duration_ms) ?? input.durationMs,
			num_turns: reported(result?.num_turns),
			total_cost_usd: reported(result?.total_cost_usd),
			usage: result?.usage ?? null,
			modelUsage: result?.modelUsage ?? null,
			session_id: result?.session_id ?? findInit(messages)?.session_id ?? null,
		},
		diagnostics: input.diagnostics,
	};

	if (input.format !== 'text' && input.includeTranscript) {
		envelope.messages = messages;
	}

	if (input.format === 'structured') {
		envelope.summary = {
			userMessageCount: messages.filter(isUser).length,
			assistantMessageCount: assistantMessages(messages).length,
			// Counted wherever it appears in the turn — see F-06.
			toolUseCount: countContent(messages, (c) => c.type === 'tool_use'),
			thinkingBlockCount: countContent(messages, (c) => c.type === 'thinking'),
			hasResult: !!result,
			toolsAvailable: findInit(messages)?.tools ?? [],
			resultTextSource: resolved.source,
		};
	}

	return envelope;
}
