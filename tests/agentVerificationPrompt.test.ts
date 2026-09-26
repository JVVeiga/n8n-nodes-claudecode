import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	DEFAULT_VERIFIER_INSTRUCTIONS,
	VERDICT_SCHEMA,
	verifierTurn,
} from '../nodes/ClaudeCodeAgent/verification/prompt';

describe('verifierTurn', () => {
	const turn = verifierTurn('  Check each claim.  ', [{ claim: 'a' }, { claim: 'b' }], [1, 4]);

	it('starts with the instructions, trimmed', () => {
		assert.ok(turn.startsWith('Check each claim.\n\n'));
	});

	it('lists the items as JSON, each under its ORIGINAL index', () => {
		const json = turn.slice(turn.indexOf('['), turn.lastIndexOf(']') + 1);
		assert.deepEqual(JSON.parse(json), [
			{ index: 1, item: { claim: 'a' } },
			{ index: 4, item: { claim: 'b' } },
		]);
		assert.match(turn, /Items to verify \(2\)/);
	});

	it('says plainly what to return', () => {
		assert.match(turn, /`keep` with the indices/);
		assert.match(turn, /`drop` with one entry per refuted item: its index and the concrete reason/);
		assert.match(turn, /Use only the indices listed above/);
	});
});

describe('VERDICT_SCHEMA', () => {
	it('is { keep: integer[], drop: [{ index, reason }] }, both required', () => {
		assert.deepEqual(VERDICT_SCHEMA, {
			type: 'object',
			properties: {
				keep: { type: 'array', items: { type: 'integer' } },
				drop: {
					type: 'array',
					items: {
						type: 'object',
						properties: { index: { type: 'integer' }, reason: { type: 'string' } },
						required: ['index', 'reason'],
					},
				},
			},
			required: ['keep', 'drop'],
		});
	});
});

describe('DEFAULT_VERIFIER_INSTRUCTIONS', () => {
	it('asks for refutation from the code, survivors only, and a reason per drop', () => {
		assert.match(DEFAULT_VERIFIER_INSTRUCTIONS, /refute/);
		assert.match(DEFAULT_VERIFIER_INSTRUCTIONS, /read the code/);
		assert.match(DEFAULT_VERIFIER_INSTRUCTIONS, /Keep only the items that survive/);
		assert.match(DEFAULT_VERIFIER_INSTRUCTIONS, /concrete reason/);
	});
});
