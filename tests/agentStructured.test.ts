import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractStructured } from '../nodes/ClaudeCodeAgent/structured';
import { assistantText, assistantTool, init, msg, SESSION } from './helpers/sdkMessages';

const success = (over: object = {}) =>
	msg({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: '{"n":3}',
		num_turns: 2,
		total_cost_usd: 0.004,
		session_id: SESSION,
		...over,
	});

const errorResult = (subtype: string, errors: string[]) =>
	msg({
		type: 'result',
		subtype,
		is_error: true,
		errors,
		num_turns: 7,
		total_cost_usd: 0.026,
		session_id: SESSION,
	});

describe('extractStructured', () => {
	it('returns the object and counts the StructuredOutput attempts', () => {
		const outcome = extractStructured([
			init({ tools: ['StructuredOutput', 'Read'] }),
			assistantTool('Read'),
			assistantTool('StructuredOutput'),
			success({ structured_output: { n: 3 } }),
		]);
		assert.deepEqual(outcome, { ok: { n: 3 }, attempts: 1 });
	});

	it('an object from an earlier result wins over a later plain success without one', () => {
		// A background subagent's notification starts a turn after the object was produced; that
		// turn ends in a success of its own with no structured_output.
		const outcome = extractStructured([
			init(),
			assistantTool('StructuredOutput'),
			success({ structured_output: { n: 3 } }),
			assistantText('The subagent finished.'),
			success({ result: 'The subagent finished.' }),
		]);
		assert.deepEqual(outcome, { ok: { n: 3 }, attempts: 1 });
	});

	it('the latest object wins when several results carry one', () => {
		const outcome = extractStructured([
			init(),
			success({ structured_output: { n: 1 } }),
			success({ structured_output: { n: 2 } }),
			success({ result: 'done' }),
		]);
		assert.deepEqual(outcome, { ok: { n: 2 }, attempts: 0 });
	});

	it('an error in the last result is not rescued by an earlier object', () => {
		const outcome = extractStructured([
			init(),
			success({ structured_output: { n: 3 } }),
			errorResult('error_during_execution', ['subagent crashed']),
		]);
		assert.deepEqual(outcome, { failure: 'subagent crashed', attempts: 0 });
	});

	it('fails a success result that carries no structured output — the prose give-up', () => {
		const outcome = extractStructured([
			init(),
			assistantTool('StructuredOutput'),
			assistantTool('StructuredOutput'),
			assistantText('I cannot satisfy this schema.'),
			success({ result: 'I cannot satisfy this schema.' }),
		]);
		assert.deepEqual(outcome, {
			failure: 'the model finished without producing the structured output',
			attempts: 2,
		});
	});

	it('fails a success result whose structured output is null', () => {
		const outcome = extractStructured([success({ structured_output: null })]);
		assert.ok('failure' in outcome);
		assert.match(outcome.failure, /without producing the structured output/);
	});

	it('fails exhausted retries with the CLI’s own message', () => {
		const text =
			'Failed to provide valid structured output after 5 attempts — last StructuredOutput ' +
			'error: Output does not match required schema: /n: must be <= 5';
		const outcome = extractStructured([
			init(),
			...Array.from({ length: 5 }, () => assistantTool('StructuredOutput')),
			errorResult('error_max_structured_output_retries', [text, 'second']),
		]);
		assert.deepEqual(outcome, { failure: text, attempts: 5 });
	});

	it('fails any other error result with its errors', () => {
		const outcome = extractStructured([errorResult('error_max_turns', ['Reached max turns (5)'])]);
		assert.deepEqual(outcome, { failure: 'Reached max turns (5)', attempts: 0 });
	});

	it('names the subtype when an error result carries no text', () => {
		const outcome = extractStructured([errorResult('error_during_execution', [])]);
		assert.ok('failure' in outcome);
		assert.match(outcome.failure, /error_during_execution/);
	});

	it('fails a run with no result at all', () => {
		const outcome = extractStructured([init(), assistantTool('StructuredOutput')]);
		assert.deepEqual(outcome, { failure: 'the run ended without a result', attempts: 1 });
	});

	it('reads the last result, not the first', () => {
		const outcome = extractStructured([
			success({ structured_output: { n: 1 } }),
			success({ structured_output: { n: 2 } }),
		]);
		assert.deepEqual(outcome, { ok: { n: 2 }, attempts: 0 });
	});
});
