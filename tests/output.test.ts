import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLegacyOutput } from '../nodes/ClaudeCode/output/legacy';
import { buildOutputItem } from '../nodes/ClaudeCode/output';
import type { OutputFormat } from '../nodes/ClaudeCode/types';
import { assistantText, init, msg, streams, successResult } from './helpers/sdkMessages';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const DIAGNOSTICS = { requestedModel: 'claude-sonnet-5' };

const legacy = (
	format: OutputFormat,
	messages: SDKMessage[],
	includeTranscript = true,
): Record<string, unknown> =>
	buildLegacyOutput({ format, messages, diagnostics: DIAGNOSTICS, includeTranscript }) as Record<
		string,
		unknown
	>;

const FORMATS: OutputFormat[] = ['text', 'messages', 'structured'];

describe('legacy output — every format, every stream', () => {
	it('always carries diagnostics', () => {
		for (const format of FORMATS) {
			for (const name of Object.keys(streams) as Array<keyof typeof streams>) {
				assert.deepEqual(
					legacy(format, streams[name]()).diagnostics,
					DIAGNOSTICS,
					`${format}/${name}`,
				);
			}
		}
	});

	it('is always JSON-serialisable — n8n cannot store anything else', () => {
		for (const format of FORMATS) {
			for (const name of Object.keys(streams) as Array<keyof typeof streams>) {
				assert.doesNotThrow(
					() => JSON.stringify(legacy(format, streams[name]())),
					`${format}/${name}`,
				);
			}
		}
	});

	it('survives an empty message array', () => {
		for (const format of FORMATS) {
			assert.doesNotThrow(() => legacy(format, []), format);
		}
	});
});

describe('legacy text format', () => {
	it('reports the result, success and the run cost', () => {
		const out = legacy('text', streams.success());
		assert.deepEqual(out, {
			result: 'pong',
			success: true,
			duration_ms: 4821,
			total_cost_usd: 0.0412,
			diagnostics: DIAGNOSTICS,
		});
	});

	it('coerces result to a string and the numbers to numbers', () => {
		const out = legacy('text', streams.success());
		assert.equal(typeof out.result, 'string');
		assert.equal(typeof out.duration_ms, 'number');
		assert.equal(typeof out.total_cost_usd, 'number');
		assert.equal(typeof out.success, 'boolean');
	});

	it('FROZEN QUIRK (F-01): claims a run was instant and free when no result arrived', () => {
		// A run with no result message may well have spent money and certainly took time. The
		// failure path already reports null for this; the text format does not. 1.2 fixes it —
		// changing it here would break every workflow reading these fields.
		const out = legacy('text', streams.noResult());
		assert.equal(out.duration_ms, 0);
		assert.equal(out.total_cost_usd, 0);
		assert.equal(out.success, false);
	});

	it('never emits an empty result string', () => {
		assert.equal(legacy('text', []).result, 'No response generated - check debug logs for details');
	});

	it('success is false for every error subtype, however the text was recovered', () => {
		for (const name of ['maxTurns', 'duringExecution', 'budgetExceeded', 'noResult'] as const) {
			assert.equal(legacy('text', streams[name]()).success, false, name);
		}
	});
});

describe('legacy messages format', () => {
	it('returns the transcript and its length', () => {
		const messages = streams.success();
		const out = legacy('messages', messages);
		assert.deepEqual(out.messages, messages);
		assert.equal(out.messageCount, 5);
	});

	it('drops the transcript but keeps the count when includeTranscript is off', () => {
		const out = legacy('messages', streams.success(), false);
		assert.equal('messages' in out, false);
		assert.equal(out.messageCount, 5);
	});

	it('FROZEN QUIRK (F-03): carries no metrics at all', () => {
		// Not cost, not duration, not the session id. A workflow that wants the transcript has to
		// run the node twice to also learn what it spent. 1.2's shared envelope fixes it.
		assert.deepEqual(Object.keys(legacy('messages', streams.success())).sort(), [
			'diagnostics',
			'messageCount',
			'messages',
		]);
	});
});

describe('legacy structured format', () => {
	it('summarises the run and nests the metrics', () => {
		const out = legacy('structured', streams.success());
		assert.deepEqual(out.summary, {
			userMessageCount: 1,
			assistantMessageCount: 2,
			toolUseCount: 1,
			hasResult: true,
			toolsAvailable: ['Bash', 'Read', 'Workflow'],
		});
		assert.deepEqual(out.metrics, {
			duration_ms: 4821,
			num_turns: 2,
			total_cost_usd: 0.0412,
			usage: { input_tokens: 12, output_tokens: 47 },
			modelUsage: {
				'claude-sonnet-5': {
					inputTokens: 4,
					outputTokens: 47,
					cacheReadInputTokens: 65361,
					cacheCreationInputTokens: 23578,
					webSearchRequests: 0,
					costUSD: 0.0412,
					contextWindow: 1000000,
					maxOutputTokens: 64000,
				},
			},
		});
		assert.equal(out.result, 'pong');
		assert.equal(out.success, true);
	});

	it('reports null metrics rather than zeroes when no result arrived', () => {
		const out = legacy('structured', streams.noResult());
		assert.equal(out.metrics, null);
		assert.equal((out.summary as { hasResult: boolean }).hasResult, false);
	});

	it('falls back to the joined errors for its result field', () => {
		assert.equal(
			legacy('structured', streams.budgetExceeded()).result,
			'[sdk] error_max_budget_usd',
		);
	});

	it('reports a null result when there is neither text nor errors', () => {
		assert.equal(legacy('structured', [init()]).result, null);
	});

	it('FROZEN QUIRK (F-06): counts a tool use only when it is the FIRST content block', () => {
		// A message that says something before calling a tool is not counted. This is what
		// `content?.[0]?.type === 'tool_use'` did, and workflows read toolUseCount.
		const toolAfterText = msg({
			type: 'assistant',
			message: {
				content: [
					{ type: 'text', text: 'let me check' },
					{ type: 'tool_use', name: 'Read', input: {} },
				],
			},
		});
		const out = legacy('structured', [init(), toolAfterText, successResult()]);
		assert.equal((out.summary as { toolUseCount: number }).toolUseCount, 0);
	});

	it('reports an empty tool list when the init message carries none', () => {
		const out = legacy('structured', [init({ tools: [] }), successResult()]);
		assert.deepEqual((out.summary as { toolsAvailable: string[] }).toolsAvailable, []);
	});

	it('drops the transcript when includeTranscript is off, keeping the summary', () => {
		const out = legacy('structured', streams.success(), false);
		assert.equal('messages' in out, false);
		assert.ok(out.summary);
	});
});

describe('legacy formats — the three derive result and success separately (C3)', () => {
	it('text and structured can disagree on result for the same run', () => {
		// text wraps a max-turns partial answer in prose; structured reports the raw errors.
		const messages = streams.maxTurns();
		assert.match(legacy('text', messages).result as string, /^\[PARTIAL - Max turns reached\]/);
		assert.equal(legacy('structured', messages).result, '[sdk] error_max_turns');
	});

	it('and messages reports neither', () => {
		assert.equal('result' in legacy('messages', streams.maxTurns()), false);
	});
});

describe('buildOutputItem — version routing', () => {
	it('routes 1 and 1.1 to the legacy builders', () => {
		for (const nodeVersion of [1, 1.1]) {
			const out = buildOutputItem({
				nodeVersion,
				format: 'text',
				messages: streams.success(),
				diagnostics: DIAGNOSTICS,
				includeTranscript: true,
			});
			assert.deepEqual(out, legacy('text', streams.success()));
		}
	});

	it('agrees with the legacy builder for every format and stream', () => {
		for (const format of FORMATS) {
			for (const name of Object.keys(streams) as Array<keyof typeof streams>) {
				const messages = streams[name]();
				assert.deepEqual(
					buildOutputItem({
						nodeVersion: 1.1,
						format,
						messages,
						diagnostics: DIAGNOSTICS,
						includeTranscript: true,
					}),
					legacy(format, messages),
					`${format}/${name}`,
				);
			}
		}
	});
});

describe('legacy output — a graceful timeout has two result messages', () => {
	it('the FIRST result is what these builders read, not the cumulative one', () => {
		// findResult takes the first, which on a graceful timeout is the interrupt's own — per-turn
		// counts, no text. timeout.ts uses the last one for its metrics; these builders do not, and
		// that difference is why the timeout report exists separately.
		const out = legacy('structured', streams.gracefulTimeout());
		assert.equal((out.metrics as { num_turns: number }).num_turns, 5, "the interrupt's own count");
		assert.equal(out.success, false, 'the interrupt result is error_during_execution');
	});

	it('the text format recovers the wrap-up summary from the transcript', () => {
		const out = legacy('text', streams.gracefulTimeout());
		assert.match(out.result as string, /^\[ERROR - Execution failed\]/);
		assert.match(out.result as string, /Read `claudecode\.svg`/);
	});
});

describe('legacy output — an empty-string result falls through', () => {
	it('does not report an empty result as the answer', () => {
		const out = legacy('text', [
			init(),
			assistantText('real answer'),
			successResult({ result: '' }),
		]);
		assert.notEqual(out.result, '');
	});
});
