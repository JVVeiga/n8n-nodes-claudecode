import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { countToolUses, isResult, lastResult } from '../shared/sdkMessage';

const hasObject = (value: unknown): boolean => value !== undefined && value !== null;

export type StructuredOutcome =
	| { ok: unknown; attempts: number }
	| { failure: string; attempts: number };

/**
 * The structured object of a run, or why there is none. A `success` result is not enough: after
 * rejected attempts the model may give up and answer in prose, which the CLI still reports as
 * success, just without `structured_output`.
 */
export function extractStructured(messages: SDKMessage[]): StructuredOutcome {
	const attempts = countToolUses(messages, 'StructuredOutput');
	const result = lastResult(messages);
	if (!result) return { failure: 'the run ended without a result', attempts };

	if (result.subtype === 'success') {
		// A turn started by a background subagent's notification ends in a success of its own,
		// without the object an earlier turn already produced.
		const produced = messages
			.filter(isResult)
			.reverse()
			.find((r) => r.subtype === 'success' && hasObject(r.structured_output));
		if (!produced || produced.subtype !== 'success') {
			return { failure: 'the model finished without producing the structured output', attempts };
		}
		return { ok: produced.structured_output, attempts };
	}

	const errors = (Array.isArray(result.errors) ? result.errors : []).filter(
		(e): e is string => typeof e === 'string' && e !== '',
	);
	if (result.subtype === 'error_max_structured_output_retries') {
		return {
			failure: errors[0] ?? 'the model did not produce valid structured output within its retries',
			attempts,
		};
	}
	return {
		failure: errors.length ? errors.join('; ') : `the run ended with ${result.subtype}`,
		attempts,
	};
}
