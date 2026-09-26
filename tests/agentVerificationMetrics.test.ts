import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { combineVerificationMetrics } from '../nodes/ClaudeCodeAgent/verification/metrics';

// Shaped after a measured create-then-resume pair: the resumed result's cost and modelUsage
// include the first query, its turns, duration and usage do not.
const main = {
	duration_ms: 2529,
	num_turns: 1,
	total_cost_usd: 0.002472,
	usage: { input_tokens: 3, output_tokens: 175 },
	modelUsage: { 'claude-haiku-4-5': { outputTokens: 187, costUSD: 0.002472 } },
	session_id: 'sess-1',
};

const verification = {
	duration_ms: 2497,
	num_turns: 1,
	total_cost_usd: 0.004218,
	usage: { input_tokens: 5, output_tokens: 172 },
	modelUsage: { 'claude-haiku-4-5': { outputTokens: 359, costUSD: 0.004218 } },
	session_id: 'sess-1',
};

describe('combineVerificationMetrics', () => {
	it('takes cost and modelUsage from the verification, sums turns and duration, keeps main usage', () => {
		const { metrics, costUsd } = combineVerificationMetrics(main, verification);
		assert.deepEqual(metrics, {
			duration_ms: 5026,
			num_turns: 2,
			total_cost_usd: 0.004218,
			usage: { input_tokens: 3, output_tokens: 175 },
			modelUsage: { 'claude-haiku-4-5': { outputTokens: 359, costUSD: 0.004218 } },
			session_id: 'sess-1',
		});
		assert.equal(costUsd, 0.001746);
	});

	it('counts the main run once: the total is not main + verification', () => {
		const { metrics } = combineVerificationMetrics(main, verification);
		assert.notEqual(metrics.total_cost_usd, main.total_cost_usd + verification.total_cost_usd);
	});

	it('a verification with no reported cost keeps the main figures and an unknown delta', () => {
		const { metrics, costUsd } = combineVerificationMetrics(main, {
			duration_ms: 900,
			num_turns: null,
			total_cost_usd: null,
			usage: null,
			modelUsage: null,
			session_id: null,
		});
		assert.equal(metrics.total_cost_usd, 0.002472);
		assert.deepEqual(metrics.modelUsage, main.modelUsage);
		assert.equal(metrics.num_turns, 1);
		assert.equal(metrics.duration_ms, 3429);
		assert.equal(costUsd, null);
	});

	it('an unknown main cost gives an unknown delta', () => {
		const { costUsd } = combineVerificationMetrics({ ...main, total_cost_usd: null }, verification);
		assert.equal(costUsd, null);
	});
});
