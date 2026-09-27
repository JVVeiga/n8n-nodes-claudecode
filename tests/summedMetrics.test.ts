import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRunMetrics, buildSummedRunMetrics } from '../nodes/ClaudeCode/output/metrics';
import {
	backgroundSubagentRun,
	init,
	model,
	SESSION,
	streams,
	successResult,
} from './helpers/sdkMessages';

describe('buildSummedRunMetrics', () => {
	it('with one result it is exactly buildRunMetrics', () => {
		for (const name of ['success', 'maxTurns', 'noResult', 'empty', 'hardAbort'] as const) {
			const messages = streams[name]();
			assert.deepEqual(buildSummedRunMetrics(messages, 77), buildRunMetrics(messages, 77), name);
		}
	});

	it('sums duration, turns and every numeric leaf of usage; the rest comes from the last', () => {
		const messages = [
			init(),
			successResult({
				num_turns: 3,
				duration_ms: 4000,
				total_cost_usd: 0.03,
				usage: {
					input_tokens: 10,
					output_tokens: 100,
					cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 0 },
					service_tier: 'standard',
					iterations: [{ output_tokens: 100 }],
					speed: null,
				},
				modelUsage: { 'claude-sonnet-5': model({ costUSD: 0.03 }) },
				session_id: 'first',
			}),
			successResult({
				num_turns: 2,
				duration_ms: 2500,
				total_cost_usd: 0.05,
				usage: {
					input_tokens: 4,
					output_tokens: 60,
					cache_creation: { ephemeral_1h_input_tokens: 3, ephemeral_5m_input_tokens: 1 },
					service_tier: 'priority',
					iterations: [{ output_tokens: 40 }, { output_tokens: 20 }],
					speed: 'fast',
				},
				modelUsage: { 'claude-haiku-5': model({ costUSD: 0.05 }) },
			}),
		];
		assert.deepEqual(buildSummedRunMetrics(messages, 1), {
			duration_ms: 6500,
			num_turns: 5,
			total_cost_usd: 0.05,
			usage: {
				input_tokens: 14,
				output_tokens: 160,
				cache_creation: { ephemeral_1h_input_tokens: 8, ephemeral_5m_input_tokens: 1 },
				service_tier: 'priority',
				iterations: [{ output_tokens: 100 }, { output_tokens: 40 }, { output_tokens: 20 }],
				speed: 'fast',
			},
			modelUsage: { 'claude-haiku-5': model({ costUSD: 0.05 }) },
			session_id: SESSION,
		});
	});

	it('a figure no result reported stays null, and a missing duration falls back to wall time', () => {
		const messages = [
			init(),
			successResult({ num_turns: undefined, duration_ms: undefined, usage: undefined }),
			successResult({ num_turns: undefined, duration_ms: undefined, usage: undefined }),
		];
		const metrics = buildSummedRunMetrics(messages, 1234);
		assert.equal(metrics.num_turns, null);
		assert.equal(metrics.duration_ms, 1234);
		assert.equal(metrics.usage, null);
	});

	it('a result without usage adds nothing to the others', () => {
		const messages = [
			init(),
			successResult({ usage: undefined, num_turns: 1, duration_ms: 10 }),
			successResult({ usage: { input_tokens: 1, output_tokens: 2 }, num_turns: 1, duration_ms: 5 }),
		];
		const metrics = buildSummedRunMetrics(messages, 0);
		assert.deepEqual(metrics.usage, { input_tokens: 1, output_tokens: 2 });
		assert.equal(metrics.num_turns, 2);
		assert.equal(metrics.duration_ms, 15);
	});

	it('buildRunMetrics itself still reads the last result only', () => {
		const metrics = buildRunMetrics(backgroundSubagentRun(), 0);
		assert.equal(metrics.duration_ms, 2210);
		assert.equal(metrics.num_turns, 1);
		assert.equal(buildSummedRunMetrics(backgroundSubagentRun(), 0).duration_ms, 5330);
	});
});
