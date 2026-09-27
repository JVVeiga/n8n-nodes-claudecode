import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { query as sdkQuery, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { IDataObject } from 'n8n-workflow';
import { runAgentItems } from '../nodes/ClaudeCodeAgent/ClaudeCodeAgent.node';
import { SUBAGENT_TAG } from '../nodes/shared/subagent';
import { createFakeContext, type ParamMap } from './helpers/executeFunctions';
import { createFakeQuery, type FakeQueryOptions } from './helpers/fakeQuery';
import {
	assistantText,
	assistantTool,
	backgroundSubagentRun,
	errorResult,
	init,
	model,
	msg,
	SESSION,
	streams,
	successResult,
	taskNotified,
	taskStarted,
} from './helpers/sdkMessages';

/**
 * The same recorded streams through Claude Code Agent 1 and 1.1.
 *
 * Version 1 is held to what it emitted before 1.1 existed: `tests/agent-v1/` was recorded from
 * that code and is compared byte-for-byte, the way `tests/fixtures/` holds the Claude Code node.
 * Record again only on purpose, with RECORD_AGENT_V1=1, and say why in the commit.
 */

const DIR = join(process.cwd(), 'tests', 'agent-v1');
const RECORD = process.env.RECORD_AGENT_V1 === '1';

const SCHEMA = {
	type: 'object',
	properties: {
		findings: {
			type: 'array',
			items: {
				type: 'object',
				properties: { line: { type: 'integer', minimum: 1 }, body: { type: 'string' } },
				required: ['line', 'body'],
			},
		},
	},
	required: ['findings'],
};

const REJECTION =
	"Output does not match required schema: /findings/1: must have required property 'line'";

const deliver = (id: string, input: unknown): SDKMessage =>
	msg({
		type: 'assistant',
		message: { content: [{ type: 'tool_use', id, name: 'StructuredOutput', input }] },
		session_id: SESSION,
	});

const accepted = (id: string): SDKMessage =>
	msg({
		type: 'user',
		message: {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: id,
					content: 'Structured output provided successfully',
				},
			],
		},
		session_id: SESSION,
	});

const rejected = (id: string, reason = REJECTION): SDKMessage =>
	msg({
		type: 'user',
		message: {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: id,
					is_error: true,
					content: [{ type: 'text', text: reason }],
				},
			],
		},
		session_id: SESSION,
	});

const FIRST = { findings: [{ line: 3, body: 'quick' }] };
const SECOND = {
	findings: [
		{ line: 3, body: 'quick' },
		{ line: 9, body: 'slow' },
	],
};

// Per-turn figures, the way a streaming session reports them; cost and modelUsage accumulate.
const firstTurn = (over: Record<string, unknown> = {}) =>
	successResult({
		num_turns: 3,
		duration_ms: 4000,
		total_cost_usd: 0.03,
		usage: {
			input_tokens: 10,
			output_tokens: 100,
			cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 0 },
			server_tool_use: { web_search_requests: 0 },
			service_tier: 'standard',
		},
		modelUsage: { 'claude-sonnet-5': model({ costUSD: 0.03 }) },
		...over,
	});

const laterTurn = (over: Record<string, unknown> = {}) =>
	successResult({
		num_turns: 2,
		duration_ms: 2500,
		total_cost_usd: 0.05,
		usage: {
			input_tokens: 4,
			output_tokens: 60,
			cache_creation: { ephemeral_1h_input_tokens: 3, ephemeral_5m_input_tokens: 1 },
			server_tool_use: { web_search_requests: 1 },
			service_tier: 'standard',
		},
		modelUsage: {
			'claude-sonnet-5': model({ costUSD: 0.04 }),
			'claude-haiku-5': model({ costUSD: 0.01 }),
		},
		...over,
	});

/** A second delivery after a background subagent reported: accepted, and it is what is emitted. */
const secondDeliveryAccepted = (): SDKMessage[] => [
	init({ tools: ['Task', 'StructuredOutput'] }),
	assistantTool('Agent'),
	taskStarted('t1', 'alpha'),
	deliver('so1', FIRST),
	accepted('so1'),
	firstTurn({ structured_output: FIRST, result: JSON.stringify(FIRST) }),
	taskNotified('t1'),
	deliver('so2', SECOND),
	accepted('so2'),
	laterTurn({ structured_output: SECOND, result: JSON.stringify(SECOND) }),
];

/** The later turn tries to replace the object, every try fails the schema, and it gives up in prose. */
const supersededDelivery = (): SDKMessage[] => [
	init({ tools: ['Task', 'StructuredOutput'] }),
	assistantTool('Agent'),
	taskStarted('t1', 'alpha'),
	deliver('so1', FIRST),
	accepted('so1'),
	firstTurn({ structured_output: FIRST, result: JSON.stringify(FIRST) }),
	taskNotified('t1'),
	deliver('so2', { findings: [{ line: 3, body: 'quick' }, { body: 'no line' }] }),
	rejected('so2'),
	deliver('so3', { findings: [{ line: 3, body: 'quick' }, { body: 'still no line' }] }),
	rejected('so3', `${REJECTION}; ${'x'.repeat(600)}`),
	assistantText('The consolidated review cannot fit the schema. Should I drop the finding?'),
	laterTurn({
		result: 'The consolidated review cannot fit the schema. Should I drop the finding?',
	}),
];

/** A rejected delivery fixed within the same turn. */
const fixedInTurn = (): SDKMessage[] => [
	init({ tools: ['StructuredOutput'] }),
	deliver('so1', { findings: [{ body: 'no line' }] }),
	rejected(
		'so1',
		"Output does not match required schema: /findings/0: must have required property 'line'",
	),
	deliver('so2', FIRST),
	accepted('so2'),
	firstTurn({ structured_output: FIRST, result: JSON.stringify(FIRST) }),
];

/** Retries exhausted: the SDK yields the error result, then throws. */
const retriesExhausted = (): FakeQueryOptions => ({
	messages: [
		init({ tools: ['StructuredOutput'] }),
		deliver('so1', {}),
		rejected(
			'so1',
			"Output does not match required schema: must have required property 'findings'",
		),
		deliver('so2', {}),
		rejected(
			'so2',
			"Output does not match required schema: must have required property 'findings'",
		),
		errorResult('error_max_structured_output_retries', {
			errors: ['Failed to provide valid structured output after 5 attempts'],
		}),
	],
	throwAfter: new Error('Failed to provide valid structured output after 5 attempts'),
});

/** Two turns, neither with an object. */
const proseOnly = (): SDKMessage[] => [
	init({ tools: ['Task'] }),
	assistantTool('Agent'),
	taskStarted('t1', 'alpha'),
	firstTurn({ result: 'Waiting for the subagent.' }),
	taskNotified('t1'),
	laterTurn({ result: 'Here is the review in prose.' }),
];

const verifierRun = (): SDKMessage[] => [
	init(),
	assistantTool('StructuredOutput'),
	successResult({
		structured_output: { keep: [0], drop: [{ index: 1, reason: 'handled elsewhere' }] },
		num_turns: 2,
		duration_ms: 3000,
		total_cost_usd: 0.08,
		usage: { input_tokens: 6, output_tokens: 120 },
		modelUsage: { 'claude-sonnet-5': model({ costUSD: 0.08 }) },
	}),
];

const subagent = (name: string, model?: string) => ({
	[SUBAGENT_TAG]: 1,
	name,
	definition: {
		description: `${name} description`,
		prompt: `You are ${name}.`,
		...(model ? { model } : {}),
	},
});

type Case = {
	params?: ParamMap;
	subagents?: unknown[];
	streams: FakeQueryOptions[];
	continueOnFail?: boolean;
};

const schemaParams: ParamMap = { outputMode: 'jsonSchema', jsonSchema: JSON.stringify(SCHEMA) };
const twoSubagents = [subagent('beta', 'haiku'), subagent('alpha', 'inherit')];

const CASES: Record<string, Case> = {
	plain: { streams: [{ messages: streams.success() }] },
	backgroundSubagent: {
		subagents: [subagent('alpha', 'inherit')],
		streams: [{ messages: backgroundSubagentRun() }],
	},
	requiredOrchestration: {
		params: { subagentOrchestration: 'required' },
		subagents: twoSubagents,
		streams: [{ messages: streams.success() }],
	},
	secondDeliveryAccepted: {
		params: schemaParams,
		subagents: twoSubagents,
		streams: [{ messages: secondDeliveryAccepted() }],
	},
	supersededDelivery: {
		params: schemaParams,
		subagents: twoSubagents,
		streams: [{ messages: supersededDelivery() }],
	},
	fixedInTurn: { params: schemaParams, streams: [{ messages: fixedInTurn() }] },
	retriesExhausted: {
		params: schemaParams,
		continueOnFail: true,
		streams: [retriesExhausted()],
	},
	proseOnly: {
		params: schemaParams,
		subagents: [subagent('alpha', 'inherit')],
		continueOnFail: true,
		streams: [{ messages: proseOnly() }],
	},
	verification: {
		params: { ...schemaParams, verification: { enabled: true, itemsPath: 'findings' } },
		subagents: twoSubagents,
		streams: [{ messages: secondDeliveryAccepted() }, { messages: verifierRun() }],
	},
};

async function drainPrompt(call: unknown): Promise<unknown[]> {
	const prompt = (call as { prompt: AsyncIterable<{ message: { content: unknown } }> }).prompt;
	const turns: unknown[] = [];
	for await (const message of prompt) turns.push(message.message.content);
	return turns;
}

type Run = {
	items: Array<{ json: IDataObject }>;
	turns: unknown[][];
	reports: unknown[];
	logs: Array<{ message: string; meta?: object }>;
};

async function run(c: Case, typeVersion: number): Promise<Run> {
	const fake = createFakeContext({
		typeVersion,
		nodeName: 'Claude Code Agent',
		continueOnFail: c.continueOnFail ?? false,
		params: {
			prompt: 'Review the change.',
			model: 'sonnet',
			projectPath: '',
			effort: 'high',
			maxTurns: 5,
			timeout: 300,
			...c.params,
			options: { reportUsageTo: 'wf-collector', debug: true },
		},
		connections: { ai_tool: undefined, ai_agent: c.subagents, ai_outputParser: undefined },
		workflow: {},
	});
	const handles = c.streams.map((o) => createFakeQuery(o));
	const calls: unknown[] = [];
	const query = ((args: unknown) => {
		const handle = handles[Math.min(calls.length, handles.length - 1)];
		calls.push(args);
		return handle.fake(args as never);
	}) as typeof sdkQuery;
	const result = await runAgentItems(fake.ctx, { query });
	const turns: unknown[][] = [];
	for (const call of calls) turns.push(await drainPrompt(call));
	return {
		items: result[0] as Run['items'],
		turns,
		reports: fake.workflowCalls.map((call) => call.payload),
		logs: fake.logs,
	};
}

const snapshot = (r: Run): string =>
	JSON.stringify({ items: r.items, turns: r.turns, reports: r.reports }, null, 2);

const jsonOf = (r: Run) => r.items[0].json;
const diagnosticsOf = (r: Run) => jsonOf(r).diagnostics as Record<string, unknown>;
const lastText = (r: Run): string => {
	const blocks = r.turns[0][0] as Array<{ type: string; text: string }> | string;
	return typeof blocks === 'string' ? blocks : blocks[blocks.length - 1].text;
};

describe('Claude Code Agent 1 — frozen on recorded streams', () => {
	if (RECORD) mkdirSync(DIR, { recursive: true });

	for (const [name, c] of Object.entries(CASES)) {
		it(`v1 ${name}`, async () => {
			const serialised = snapshot(await run(c, 1));
			const path = join(DIR, `${name}.json`);
			if (RECORD) {
				writeFileSync(path, serialised + '\n');
				return;
			}
			assert.ok(existsSync(path), `missing ${path} — record it with RECORD_AGENT_V1=1`);
			assert.equal(serialised, readFileSync(path, 'utf8').trimEnd(), `v1 ${name} changed`);
		});
	}
});

describe('Read Instruction Files From Ref — empty is the same as absent, in 1 and 1.1', () => {
	for (const [name, c] of Object.entries(CASES)) {
		for (const typeVersion of [1, 1.1]) {
			it(`v${typeVersion} ${name}`, async () => {
				const absent = snapshot(await run(c, typeVersion));
				const empty = snapshot(
					await run({ ...c, params: { ...c.params, instructionFilesRef: '' } }, typeVersion),
				);
				assert.equal(empty, absent);
			});
		}
	}
});

const metricsOf = (r: Run) => jsonOf(r).metrics as Record<string, unknown>;
const structuredDiagnostics = (r: Run) => diagnosticsOf(r).structuredOutput as IDataObject;

const SUMMED_USAGE = {
	input_tokens: 14,
	output_tokens: 160,
	cache_creation: { ephemeral_1h_input_tokens: 8, ephemeral_5m_input_tokens: 1 },
	server_tool_use: { web_search_requests: 1 },
	service_tier: 'standard',
};

describe('Claude Code Agent 1.1 — structured deliveries', () => {
	it('two accepted deliveries: the second is emitted and nothing is superseded', async () => {
		const r = await run(CASES.secondDeliveryAccepted, 1.1);
		assert.deepEqual(jsonOf(r).structured, SECOND);
		assert.deepEqual(structuredDiagnostics(r), {
			mode: 'jsonSchema',
			attempts: 2,
			accepted: 2,
			rejected: 0,
			rejections: [],
			superseded: false,
		});
	});

	it('rejected tries after the emitted object mark it superseded, with the validator’s reasons', async () => {
		const r = await run(CASES.supersededDelivery, 1.1);
		assert.deepEqual(jsonOf(r).structured, FIRST);
		const report = structuredDiagnostics(r);
		assert.equal(report.attempts, 3);
		assert.equal(report.accepted, 1);
		assert.equal(report.rejected, 2);
		assert.equal(report.superseded, true);
		const rejections = report.rejections as string[];
		assert.equal(rejections.length, 2);
		assert.equal(rejections[0], REJECTION);
		assert.ok(rejections[1].startsWith(REJECTION));
		assert.ok(rejections[1].endsWith('…'), 'a long message is truncated');
		assert.ok(rejections[1].length < 600);
		assert.ok(
			r.logs.some((l) => /superseded/i.test(l.message)),
			'the debug log says the emitted object was superseded',
		);
	});

	it('a rejection fixed in the same turn is not a superseded object', async () => {
		const r = await run(CASES.fixedInTurn, 1.1);
		assert.deepEqual(jsonOf(r).structured, FIRST);
		assert.equal(structuredDiagnostics(r).accepted, 1);
		assert.equal(structuredDiagnostics(r).rejected, 1);
		assert.equal(structuredDiagnostics(r).superseded, false);
	});

	it('retries exhausted: the failure item counts the rejections and supersedes nothing', async () => {
		const r = await run(CASES.retriesExhausted, 1.1);
		const details = jsonOf(r).details as IDataObject;
		assert.equal(details.errorType, 'structured_output');
		const report = (details.diagnostics as IDataObject).structuredOutput as IDataObject;
		assert.equal(report.accepted, 0);
		assert.equal(report.rejected, 2);
		assert.equal(report.superseded, false);
	});

	it('version 1 has none of the new keys', async () => {
		for (const name of ['secondDeliveryAccepted', 'supersededDelivery', 'fixedInTurn']) {
			const r = await run(CASES[name], 1);
			assert.deepEqual(Object.keys(structuredDiagnostics(r)), ['mode', 'attempts'], name);
		}
	});
});

describe('Claude Code Agent 1.1 — the unattended instruction', () => {
	it('ends the user turn, after the prompt', async () => {
		const r = await run(CASES.plain, 1.1);
		const blocks = r.turns[0][0] as Array<{ type: string; text: string }>;
		assert.equal(blocks[0].text, 'Review the change.');
		assert.equal(blocks.length, 2);
		assert.match(lastText(r), /unattended/);
		assert.match(lastText(r), /never end with a question/i);
		assert.doesNotMatch(lastText(r), /structured output/i);
	});

	it('comes after the Required orchestration line', async () => {
		const r = await run(CASES.requiredOrchestration, 1.1);
		const blocks = r.turns[0][0] as Array<{ type: string; text: string }>;
		assert.match(blocks[blocks.length - 2].text, /delegate to EVERY/);
		assert.match(lastText(r), /unattended/);
	});

	it('with a schema and subagents, asks for one delivery after they report', async () => {
		const r = await run(CASES.secondDeliveryAccepted, 1.1);
		assert.match(lastText(r), /structured output once/);
		assert.match(lastText(r), /every subagent/);
		assert.match(lastText(r), /validator/);
	});

	it('a schema without subagents gets the plain instruction', async () => {
		const r = await run(CASES.fixedInTurn, 1.1);
		assert.match(lastText(r), /unattended/);
		assert.doesNotMatch(lastText(r), /subagent/);
	});

	it('is not sent to the verifier, and not by version 1', async () => {
		const r = await run(CASES.verification, 1.1);
		assert.equal(typeof r.turns[1][0], 'string');
		assert.doesNotMatch(r.turns[1][0] as string, /unattended/);
		const v1 = await run(CASES.plain, 1);
		assert.deepEqual(v1.turns, [['Review the change.']]);
	});
});

describe('Claude Code Agent 1.1 — metrics summed over the run’s results', () => {
	it('duration, turns and usage are summed; cost, modelUsage and session from the last', async () => {
		const r = await run(CASES.secondDeliveryAccepted, 1.1);
		const metrics = metricsOf(r);
		assert.equal(metrics.duration_ms, 6500);
		assert.equal(metrics.num_turns, 5);
		assert.deepEqual(metrics.usage, SUMMED_USAGE);
		assert.equal(metrics.total_cost_usd, 0.05);
		assert.deepEqual(Object.keys(metrics.modelUsage as object), [
			'claude-sonnet-5',
			'claude-haiku-5',
		]);
		assert.equal(metrics.session_id, SESSION);
		const v1 = metricsOf(await run(CASES.secondDeliveryAccepted, 1));
		assert.equal(v1.duration_ms, 2500);
		assert.equal(v1.num_turns, 2);
	});

	it('the usage report carries the same summed metrics', async () => {
		const r = await run(CASES.backgroundSubagent, 1.1);
		assert.equal(metricsOf(r).duration_ms, 5330);
		assert.equal(metricsOf(r).num_turns, 2);
		assert.deepEqual(metricsOf(r).usage, { input_tokens: 24, output_tokens: 94 });
		assert.equal(r.reports.length, 1);
		assert.deepEqual((r.reports[0] as IDataObject).metrics, metricsOf(r));
	});

	it('a structured failure item carries the summed metrics', async () => {
		const r = await run(CASES.proseOnly, 1.1);
		const metrics = (jsonOf(r).details as IDataObject).metrics as IDataObject;
		assert.equal(metrics.duration_ms, 6500);
		assert.equal(metrics.num_turns, 5);
		assert.deepEqual(metrics.usage, SUMMED_USAGE);
	});

	it('a verification run adds its turns and duration on top of the sums', async () => {
		const r = await run(CASES.verification, 1.1);
		const metrics = metricsOf(r);
		assert.equal(metrics.num_turns, 7);
		assert.equal(metrics.duration_ms, 9500);
		assert.deepEqual(metrics.usage, SUMMED_USAGE);
		assert.equal(metrics.total_cost_usd, 0.08);
		assert.equal((jsonOf(r).verification as IDataObject).costUsd, 0.03);
		assert.equal(r.reports.length, 1);
		assert.deepEqual((r.reports[0] as IDataObject).metrics, metrics);
	});

	it('a single-result run reports what version 1 does', async () => {
		const [v1, v11] = [await run(CASES.plain, 1), await run(CASES.plain, 1.1)];
		assert.deepEqual(v11.items, v1.items);
		assert.deepEqual(v11.reports, v1.reports);
	});
});

describe('Claude Code Agent 1.1 — the subagents’ models', () => {
	it('each subagent reports its configured model, inherit resolved to the Agent’s', async () => {
		const r = await run(CASES.secondDeliveryAccepted, 1.1);
		const report = diagnosticsOf(r).subagents as Array<{ name: string; model: string | null }>;
		assert.deepEqual(
			report.map((s) => [s.name, s.model]),
			[
				['alpha', 'sonnet'],
				['beta', 'haiku'],
			],
		);
		const v1 = diagnosticsOf(await run(CASES.secondDeliveryAccepted, 1)).subagents as object[];
		assert.equal('model' in v1[0], false);
	});
});
