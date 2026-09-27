import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractStructured, structuredDeliveries } from '../nodes/ClaudeCodeAgent/structured';
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

const deliver = (id: string | undefined) =>
	msg({
		type: 'assistant',
		message: { content: [{ type: 'tool_use', ...(id ? { id } : {}), name: 'StructuredOutput' }] },
		session_id: SESSION,
	});

const answer = (id: string, content: unknown, isError = false) =>
	msg({
		type: 'user',
		message: {
			role: 'user',
			content: [
				{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) },
			],
		},
		session_id: SESSION,
	});

const ok = (id: string) => answer(id, 'Structured output provided successfully');
const refused = (id: string, reason: string) =>
	answer(id, [{ type: 'text', text: `Output does not match required schema: ${reason}` }], true);

describe('structuredDeliveries', () => {
	it('pairs each call with its result by id and counts both outcomes', () => {
		const report = structuredDeliveries([
			init(),
			deliver('a'),
			refused('a', '/n: must be integer'),
			deliver('b'),
			ok('b'),
			success({ structured_output: { n: 3 } }),
		]);
		assert.deepEqual(report, {
			accepted: 1,
			rejected: 1,
			rejections: ['Output does not match required schema: /n: must be integer'],
			superseded: false,
		});
	});

	it('a string tool_result content is read as the message', () => {
		const report = structuredDeliveries([deliver('a'), answer('a', 'plain reason', true)]);
		assert.deepEqual(report.rejections, ['plain reason']);
	});

	it('a rejection after the emitted object, with no later acceptance, supersedes it', () => {
		const report = structuredDeliveries([
			deliver('a'),
			ok('a'),
			success({ structured_output: { n: 1 } }),
			deliver('b'),
			refused('b', "/items/1: must have required property 'line'"),
			success({ result: 'Should I drop it?' }),
		]);
		assert.equal(report.superseded, true);
		assert.equal(report.accepted, 1);
		assert.equal(report.rejected, 1);
	});

	it('a rejection after the accepted call, in the same turn, supersedes it too', () => {
		const report = structuredDeliveries([
			deliver('a'),
			ok('a'),
			deliver('b'),
			refused('b', 'no'),
			success({ structured_output: { n: 1 } }),
		]);
		assert.equal(report.superseded, true);
	});

	it('an accepted and a refused call in the same assistant message supersede nothing', () => {
		for (const order of [
			['a', 'b'],
			['b', 'a'],
		]) {
			const report = structuredDeliveries([
				msg({
					type: 'assistant',
					message: {
						content: order.map((id) => ({ type: 'tool_use', id, name: 'StructuredOutput' })),
					},
					session_id: SESSION,
				}),
				ok('a'),
				refused('b', 'no'),
				success({ structured_output: { n: 1 } }),
			]);
			assert.equal(report.accepted, 1, order.join());
			assert.equal(report.rejected, 1, order.join());
			assert.equal(report.superseded, false, order.join());
		}
	});

	it('an acceptance after the last rejection means nothing was superseded', () => {
		const report = structuredDeliveries([
			deliver('a'),
			ok('a'),
			success({ structured_output: { n: 1 } }),
			deliver('b'),
			refused('b', 'no'),
			deliver('c'),
			ok('c'),
			success({ structured_output: { n: 2 } }),
		]);
		assert.equal(report.superseded, false);
		assert.equal(report.accepted, 2);
	});

	it('nothing is superseded when no object was emitted', () => {
		const report = structuredDeliveries([
			deliver('a'),
			refused('a', 'no'),
			errorResult('error_max_structured_output_retries', ['Failed']),
		]);
		assert.equal(report.superseded, false);
		assert.equal(report.rejected, 1);
	});

	it('keeps the last five rejections, each truncated', () => {
		const messages = [init()];
		for (let i = 0; i < 7; i++) {
			messages.push(
				deliver(`r${i}`),
				answer(`r${i}`, `reason ${i} ${'x'.repeat(i === 6 ? 900 : 0)}`, true),
			);
		}
		const report = structuredDeliveries(messages);
		assert.equal(report.rejected, 7);
		assert.equal(report.rejections.length, 5);
		assert.ok(report.rejections[0].startsWith('reason 2'));
		assert.ok(report.rejections[4].startsWith('reason 6'));
		assert.ok(report.rejections[4].endsWith('…'));
		assert.ok(report.rejections[4].length < 900);
	});

	it('a call with no id, or no result yet, is counted as neither', () => {
		const report = structuredDeliveries([deliver(undefined), deliver('a'), init()]);
		assert.deepEqual(report, { accepted: 0, rejected: 0, rejections: [], superseded: false });
	});
});
