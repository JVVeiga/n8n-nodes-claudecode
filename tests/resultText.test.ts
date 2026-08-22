import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveResultText } from '../nodes/ClaudeCode/output/resultText';
import {
	assistantText,
	assistantTool,
	errorResult,
	init,
	msg,
	streams,
	successResult,
} from './helpers/sdkMessages';

describe('resolveResultText — rung 1: the result message has text', () => {
	it('uses it verbatim', () => {
		const r = resolveResultText(streams.success());
		assert.equal(r.text, 'pong');
		assert.equal(r.source, 'result');
		assert.equal(r.errorText, '');
		assert.equal(r.success, true);
	});

	it('an empty-string result is not an answer and falls through', () => {
		const r = resolveResultText([
			init(),
			assistantText('the real answer'),
			successResult({ result: '' }),
		]);
		assert.notEqual(r.text, '');
		assert.notEqual(r.source, 'result');
	});
});

describe('resolveResultText — rung 2: error_max_turns', () => {
	it('wraps the partial answer and tells the user which knob to turn', () => {
		const r = resolveResultText(streams.maxTurns());
		assert.equal(
			r.text,
			'[PARTIAL - Max turns reached]\n\nhalfway through the refactor\n\n' +
				'[Note: Task incomplete. Increase maxTurns parameter to complete.]',
		);
		assert.equal(r.source, 'assistant');
		assert.equal(r.success, false);
	});

	it('reports the SDK errors separately from the prose', () => {
		assert.equal(resolveResultText(streams.maxTurns()).errorText, '[sdk] error_max_turns');
	});

	it('falls back to a fixed message when the last assistant turn has no text', () => {
		const r = resolveResultText(streams.maxTurnsNoText());
		assert.equal(
			r.text,
			'Error: Maximum conversation turns reached. Consider increasing maxTurns parameter.',
		);
		assert.equal(r.source, null);
	});

	it('uses the SDK errors when present, a generic label when not', () => {
		const withoutErrors = [init(), errorResult('error_max_turns', { errors: [] })];
		assert.equal(resolveResultText(withoutErrors).errorText, 'Maximum turns reached');
	});
});

describe('resolveResultText — rung 3: error_during_execution', () => {
	it('wraps the partial answer', () => {
		const r = resolveResultText(streams.duringExecution());
		assert.equal(
			r.text,
			'[ERROR - Execution failed]\n\nstarted reading the files\n\n' +
				'[Note: An error occurred during execution. Check logs for details.]',
		);
		assert.equal(r.source, 'assistant');
	});

	it('distinguishes "no text in the last turn" from "no assistant turns at all"', () => {
		// Two different messages, deliberately — one says the logs may help, the other says there
		// was nothing to show.
		const noText = resolveResultText([
			init(),
			assistantTool('Read'),
			errorResult('error_during_execution'),
		]);
		assert.equal(noText.text, 'Error: Execution failed. Check debug logs for details.');

		const noAssistant = resolveResultText([init(), errorResult('error_during_execution')]);
		assert.equal(noAssistant.text, 'Error: Execution failed. No output available.');
	});
});

describe('resolveResultText — rung 4: other error subtypes', () => {
	it('reports the joined errors for a budget stop', () => {
		const r = resolveResultText(streams.budgetExceeded());
		assert.equal(r.text, 'Error: [sdk] error_max_budget_usd');
		assert.equal(r.errorText, '[sdk] error_max_budget_usd');
		assert.equal(r.source, null);
	});

	it('joins multiple errors with a semicolon', () => {
		const r = resolveResultText([
			init(),
			errorResult('error_max_structured_output_retries', { errors: ['first', 'second'] }),
		]);
		assert.equal(r.text, 'Error: first; second');
		assert.equal(r.errorText, 'first; second');
	});
});

describe('resolveResultText — rungs 5 and 6: no result message', () => {
	it("takes the transcript's last word", () => {
		const r = resolveResultText(streams.noResult());
		assert.equal(r.text, 'almost done');
		assert.equal(r.source, 'assistant');
		assert.equal(r.success, false);
	});

	it('falls back to the placeholder when there is nothing at all', () => {
		const r = resolveResultText(streams.empty());
		assert.equal(r.text, 'No response generated - check debug logs for details');
		assert.equal(r.source, null);
	});

	it('handles a completely empty stream', () => {
		assert.equal(
			resolveResultText([]).text,
			'No response generated - check debug logs for details',
		);
	});
});

describe('resolveResultText — the branch-order hazard', () => {
	// Every SDKResultError carries a non-empty `errors` array. If the generic `errors.length` rung
	// were tested before the specific subtypes, all the recovery branches would become dead code and
	// a max-turns run would report a bare "Error: ..." instead of its partial answer. This is the
	// test that stops someone reordering them.
	it('a max-turns result that ALSO has errors still takes the max-turns branch', () => {
		const messages = [
			init(),
			assistantText('partial work'),
			errorResult('error_max_turns', { errors: ['[sdk] error_max_turns'] }),
		];
		const r = resolveResultText(messages);
		assert.match(r.text, /^\[PARTIAL - Max turns reached\]/);
		assert.notEqual(r.text, 'Error: [sdk] error_max_turns');
	});

	it('an execution-error result that ALSO has errors still takes the execution branch', () => {
		const messages = [
			init(),
			assistantText('partial work'),
			errorResult('error_during_execution', { errors: ['boom'] }),
		];
		assert.match(resolveResultText(messages).text, /^\[ERROR - Execution failed\]/);
	});

	it('a result with text wins over every error branch', () => {
		const messages = [
			init(),
			assistantText('ignored'),
			errorResult('error_max_turns', { result: 'the answer arrived anyway' }),
		];
		const r = resolveResultText(messages);
		assert.equal(r.text, 'the answer arrived anyway');
		assert.equal(r.source, 'result');
	});
});

describe('resolveResultText — success is explicit, never inferred', () => {
	it('only an explicit success subtype counts', () => {
		assert.equal(resolveResultText(streams.success()).success, true);
		assert.equal(resolveResultText(streams.noResult()).success, false);
		assert.equal(resolveResultText(streams.maxTurns()).success, false);
		assert.equal(resolveResultText([]).success, false);
	});

	it('a result with neither text nor errors is not a success', () => {
		const r = resolveResultText([init(), msg({ type: 'result', subtype: 'whatever' })]);
		assert.equal(r.success, false);
		assert.equal(r.text, 'No response generated');
	});
});

describe('resolveResultText — the final-turn-only rule', () => {
	it('looks at the LAST assistant message only, not the last one with text', () => {
		// The pre-refactor behaviour: a tool_use as the final turn hides the earlier text. Preserved
		// on 1/1.1 (F-05 in STATE.md proposes the backwards search for 1.2).
		const messages = [
			init(),
			assistantText('this useful text is not reported'),
			assistantTool('Read'),
			errorResult('error_max_turns'),
		];
		const r = resolveResultText(messages);
		assert.equal(
			r.text,
			'Error: Maximum conversation turns reached. Consider increasing maxTurns parameter.',
		);
		assert.equal(r.source, null);
	});
});
