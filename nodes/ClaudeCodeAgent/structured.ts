import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { countToolUses, lastResult } from '../shared/sdkMessage';

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
		if (result.structured_output === undefined || result.structured_output === null) {
			return { failure: 'the model finished without producing the structured output', attempts };
		}
		return { ok: result.structured_output, attempts };
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
