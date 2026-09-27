import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { preview } from '../shared/preview';
import { countToolUses, isResult, lastResult, toolCalls } from '../shared/sdkMessage';

const hasObject = (value: unknown): boolean => value !== undefined && value !== null;

/** Index of the last successful result that carries an object; -1 when there is none. */
function producedAt(messages: SDKMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (isResult(m) && m.subtype === 'success' && hasObject(m.structured_output)) return i;
	}
	return -1;
}

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
		const produced = messages[producedAt(messages)];
		if (!produced || !isResult(produced) || produced.subtype !== 'success') {
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

export type StructuredDeliveries = {
	accepted: number;
	rejected: number;
	/** The validator's messages, the most recent kept. */
	rejections: string[];
	/** A delivery after the emitted object was refused, and none after it was accepted. */
	superseded: boolean;
};

const MAX_REJECTIONS = 5;
const REJECTION_LIMIT = 300;

/**
 * What became of each StructuredOutput call. A refused one comes back as an error tool result
 * carrying the validator's message, and the run goes on; the object emitted is still the last one
 * accepted, which is why a refusal after it has to be reported rather than inferred.
 */
export function structuredDeliveries(messages: SDKMessage[]): StructuredDeliveries {
	const calls = toolCalls(messages, 'StructuredOutput');
	const refused = calls.filter((c) => c.outcome?.isError === true);
	const accepted = calls.filter((c) => c.outcome?.isError === false);

	const final = lastResult(messages);
	const emittedAt = final?.subtype === 'success' ? producedAt(messages) : -1;
	let superseded = false;
	if (emittedAt >= 0) {
		const anchor = accepted.filter((c) => c.position < emittedAt).pop()?.position ?? emittedAt;
		const lastRefused = refused[refused.length - 1];
		superseded =
			lastRefused !== undefined &&
			lastRefused.position > anchor &&
			!accepted.some((c) => c.position > lastRefused.position);
	}

	return {
		accepted: accepted.length,
		rejected: refused.length,
		rejections: refused
			.slice(-MAX_REJECTIONS)
			.map((c) => preview(c.outcome?.text ?? '', REJECTION_LIMIT)),
		superseded,
	};
}
