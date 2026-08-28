import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { assistantMessages, contentOf, findResult } from '../../shared/sdkMessage';
import type { ResultTextSource } from '../timeout';

/**
 * Resolving "what does this run say" from a message stream.
 *
 * This was a 140-line if/else ladder inside execute(), and its branch ORDER is load-bearing in a
 * way only a comment recorded: every SDKResultError carries a non-empty `errors` array, so testing
 * `errors.length` before the specific subtypes turns all the recovery branches into dead code. That
 * hazard is now a test (`resultText.test.ts`), not a comment.
 *
 * The rungs, in the order they must be tried:
 *
 *   1. `result` is non-empty            -> use it verbatim
 *   2. subtype `error_max_turns`        -> wrap the partial answer, or a "raise maxTurns" message
 *   3. subtype `error_during_execution` -> wrap the partial answer, or a "check the logs" message
 *   4. any other subtype with errors    -> `Error: <joined errors>`
 *   5. no result message at all         -> the transcript's own last word
 *   6. nothing usable                   -> a fixed placeholder
 */

export type ResolvedText = {
	/** What goes in the item's `result` field. Never empty. */
	text: string;
	/** The raw error text, separate from the prose in `text`. Empty when the run did not fail. */
	errorText: string;
	source: ResultTextSource;
	/** True only for an explicit success subtype. Absence of an error is not success. */
	success: boolean;
};

const NO_RESPONSE_PLACEHOLDER = 'No response generated - check debug logs for details';
const NO_RESPONSE_FALLBACK = 'No response generated';
const MAX_TURNS_MESSAGE =
	'Error: Maximum conversation turns reached. Consider increasing maxTurns parameter.';
const EXECUTION_FAILED_MESSAGE = 'Error: Execution failed. Check debug logs for details.';
const EXECUTION_FAILED_NO_OUTPUT = 'Error: Execution failed. No output available.';

/**
 * Text of the LAST assistant message, or null.
 *
 * Deliberately not `lastAssistantText` from shared/sdkMessage, which searches backwards for the
 * last message that HAS text. This looks only at the final assistant message: if that one is a
 * tool_use with no text block, the ladder falls through to its generic message even though an
 * earlier turn said something useful. That is the pre-refactor behaviour and typeVersion 1/1.1 keep
 * it (see F-05 — the backwards search is the better answer and is a 1.2 candidate).
 */
const textOfFinalAssistantMessage = (messages: SDKMessage[]): string | null => {
	const assistants = assistantMessages(messages);
	if (assistants.length === 0) return null;
	const text = contentOf(assistants[assistants.length - 1]).find((c) => c.type === 'text')?.text;
	return text ? text : null;
};

const joinErrors = (result: { errors?: string[] }, fallback: string): string =>
	result.errors?.join('; ') || fallback;

export function resolveResultText(messages: SDKMessage[]): ResolvedText {
	const result = findResult(messages) as
		| ({ subtype?: string; result?: unknown; errors?: string[] } & SDKMessage)
		| undefined;

	if (!result) {
		// Rung 5/6: no result message means the run was cut off. The transcript is all there is.
		const partial = textOfFinalAssistantMessage(messages);
		return {
			text: partial ?? NO_RESPONSE_PLACEHOLDER,
			errorText: '',
			source: partial ? 'assistant' : null,
			success: false,
		};
	}

	// Rung 1. An empty-string `result` is not an answer, so it falls through — matching the original
	// truthiness check rather than a presence check.
	if (typeof result.result === 'string' && result.result !== '') {
		return {
			text: result.result,
			errorText: '',
			source: 'result',
			success: result.subtype === 'success',
		};
	}

	const success = result.subtype === 'success';

	// Rungs 2 and 3 differ only in their wording, so they share one shape.
	const recovery =
		result.subtype === 'error_max_turns'
			? {
					errorFallback: 'Maximum turns reached',
					wrap: (text: string) =>
						`[PARTIAL - Max turns reached]\n\n${text}\n\n[Note: Task incomplete. Increase maxTurns parameter to complete.]`,
					noText: MAX_TURNS_MESSAGE,
					noAssistant: MAX_TURNS_MESSAGE,
				}
			: result.subtype === 'error_during_execution'
				? {
						errorFallback: 'Error during execution',
						wrap: (text: string) =>
							`[ERROR - Execution failed]\n\n${text}\n\n[Note: An error occurred during execution. Check logs for details.]`,
						noText: EXECUTION_FAILED_MESSAGE,
						noAssistant: EXECUTION_FAILED_NO_OUTPUT,
					}
				: null;

	if (recovery) {
		const errorText = joinErrors(result, recovery.errorFallback);
		const assistants = assistantMessages(messages);
		if (assistants.length === 0) {
			return { text: recovery.noAssistant, errorText, source: null, success };
		}
		const partial = textOfFinalAssistantMessage(messages);
		return partial
			? { text: recovery.wrap(partial), errorText, source: 'assistant', success }
			: { text: recovery.noText, errorText, source: null, success };
	}

	// Rung 4: the remaining error subtypes — error_max_budget_usd,
	// error_max_structured_output_retries — have no bespoke recovery.
	if (result.errors?.length) {
		const errorText = result.errors.join('; ');
		return { text: `Error: ${errorText}`, errorText, source: null, success };
	}

	// A result message with neither text nor errors. Rare, but it reached the same placeholder
	// before and still does.
	return { text: NO_RESPONSE_FALLBACK, errorText: '', source: null, success };
}
