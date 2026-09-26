import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { query as sdkQuery, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { NodeOperationError, type IDataObject } from 'n8n-workflow';
import { runAgentItems } from '../nodes/ClaudeCodeAgent/ClaudeCodeAgent.node';
import { VERDICT_SCHEMA } from '../nodes/ClaudeCodeAgent/verification/prompt';
import { SUBAGENT_TAG } from '../nodes/shared/subagent';
import { toSessionUuid } from '../nodes/shared/session';
import { createFakeContext, type ParamMap } from './helpers/executeFunctions';
import { createFakeQuery, type FakeQueryOptions } from './helpers/fakeQuery';
import {
	assistantText,
	assistantTool,
	errorResult,
	init,
	model,
	successResult,
} from './helpers/sdkMessages';

const MAIN_SESSION = '7c1f0a2e-5b1d-4c3e-9f00-1a2b3c4d5e6f';

const SCHEMA = {
	type: 'object',
	properties: {
		summary: { type: 'string' },
		findings: { type: 'array', items: { type: 'object' } },
	},
	required: ['summary', 'findings'],
};

const FINDINGS = [
	{ file: 'a.ts', claim: 'A', severity: 'high' },
	{ file: 'b.ts', claim: 'B', severity: 'high' },
	{ file: 'c.ts', claim: 'C', severity: 'low' },
];

const answer = (findings: unknown[] = FINDINGS) => ({ summary: 'three findings', findings });

const mainRun = (structured: unknown = answer()): SDKMessage[] => [
	init({ sessionId: MAIN_SESSION }),
	assistantTool('StructuredOutput'),
	assistantText('Done.'),
	successResult({
		structured_output: structured,
		num_turns: 3,
		duration_ms: 5000,
		total_cost_usd: 0.03,
		usage: { input_tokens: 10, output_tokens: 300 },
		modelUsage: { 'claude-sonnet-5': model({ outputTokens: 300, costUSD: 0.03 }) },
		session_id: MAIN_SESSION,
	}),
];

// The resumed result's cost and modelUsage are cumulative for the session; turns, duration and
// usage cover this query only.
const verifierRun = (verdict: unknown): SDKMessage[] => [
	init({ sessionId: MAIN_SESSION }),
	assistantTool('Read'),
	assistantTool('StructuredOutput'),
	successResult({
		structured_output: verdict,
		num_turns: 2,
		duration_ms: 3000,
		total_cost_usd: 0.05,
		usage: { input_tokens: 6, output_tokens: 120 },
		modelUsage: { 'claude-sonnet-5': model({ outputTokens: 420, costUSD: 0.05 }) },
		session_id: MAIN_SESSION,
	}),
];

const agentParams = (over: ParamMap = {}): ParamMap => ({
	prompt: 'Review the change.',
	model: 'sonnet',
	projectPath: '',
	effort: 'high',
	maxTurns: 5,
	timeout: 300,
	outputMode: 'jsonSchema',
	jsonSchema: JSON.stringify(SCHEMA),
	options: {},
	...over,
});

const verifying = (over: IDataObject = {}): ParamMap => ({
	verification: { enabled: true, itemsPath: 'findings', ...over },
});

function sequencedQuery(perCall: FakeQueryOptions[]) {
	const handles = perCall.map((o) => createFakeQuery(o));
	const calls: unknown[] = [];
	const fake = ((args: unknown) => {
		const handle = handles[Math.min(calls.length, handles.length - 1)];
		calls.push(args);
		return handle.fake(args as never);
	}) as typeof sdkQuery;
	return { fake, calls };
}

type Options = Record<string, unknown> & {
	resume?: string;
	sessionId?: string;
	outputFormat?: unknown;
	agents?: Record<string, unknown>;
	settings?: Record<string, unknown>;
};

type ExecOpts = {
	params?: ParamMap;
	streams: FakeQueryOptions[];
	continueOnFail?: boolean;
	connections?: Record<string, unknown>;
	reporting?: boolean;
};

function setup(opts: ExecOpts) {
	const fake = createFakeContext({
		typeVersion: 1,
		nodeName: 'Claude Code Agent',
		continueOnFail: opts.continueOnFail ?? false,
		params: agentParams(opts.params),
		connections: {
			ai_tool: undefined,
			ai_agent: undefined,
			ai_outputParser: undefined,
			...opts.connections,
		},
		...(opts.reporting ? { workflow: {} } : {}),
	});
	return { fake, seq: sequencedQuery(opts.streams) };
}

async function exec(opts: ExecOpts) {
	const { fake, seq } = setup(opts);
	const result = await runAgentItems(fake.ctx, { query: seq.fake });
	const optionsOf = (i: number) => (seq.calls[i] as { options: Options }).options;
	return { json: result[0][0].json as IDataObject, calls: seq.calls, optionsOf, fake };
}

async function execExpectingThrow(opts: ExecOpts) {
	const { fake, seq } = setup(opts);
	try {
		await runAgentItems(fake.ctx, { query: seq.fake });
	} catch (error) {
		return { error: error as NodeOperationError, calls: seq.calls };
	}
	assert.fail('expected runAgentItems to throw');
}

async function drainPrompt(call: unknown): Promise<unknown[]> {
	const prompt = (call as { prompt: AsyncIterable<{ message: { content: unknown } }> }).prompt;
	const turns: unknown[] = [];
	for await (const message of prompt) turns.push(message.message.content);
	return turns;
}

const verificationOf = (json: IDataObject) => json.verification as Record<string, unknown>;
const metricsOf = (json: IDataObject) => json.metrics as Record<string, unknown>;

describe('Claude Code Agent Verification — a verdict is applied', () => {
	it('resumes the main run’s session with the verdict schema and drops what it refutes', async () => {
		const { json, calls, optionsOf } = await exec({
			params: verifying(),
			streams: [
				{ messages: mainRun() },
				{ messages: verifierRun({ keep: [0, 2], drop: [{ index: 1, reason: 'b.ts checks it' }] }) },
			],
		});
		assert.equal(calls.length, 2);
		assert.equal(optionsOf(0).resume, undefined);
		assert.deepEqual(optionsOf(0).outputFormat, { type: 'json_schema', schema: SCHEMA });
		assert.equal(optionsOf(1).resume, MAIN_SESSION);
		assert.equal(optionsOf(1).sessionId, undefined);
		assert.equal(optionsOf(0).forkSession, undefined);
		assert.equal(optionsOf(1).forkSession, true, 'the verifier never writes into the session');
		assert.deepEqual(optionsOf(1).outputFormat, { type: 'json_schema', schema: VERDICT_SCHEMA });

		assert.equal(json.success, true);
		assert.deepEqual(json.structured, answer([FINDINGS[0], FINDINGS[2]]));
		assert.deepEqual(verificationOf(json), {
			status: 'verified',
			checked: 3,
			kept: 2,
			dropped: 1,
			unjudged: [],
			droppedItems: [{ index: 1, reason: 'b.ts checks it', item: FINDINGS[1] }],
			costUsd: 0.02,
		});
	});

	it('the verifier turn lists the selected items by original index, in a plain string', async () => {
		const { calls } = await exec({
			params: verifying({ filterField: 'severity', filterValues: 'low' }),
			streams: [{ messages: mainRun() }, { messages: verifierRun({ keep: [2], drop: [] }) }],
		});
		const [turn] = await drainPrompt(calls[1]);
		assert.equal(typeof turn, 'string');
		assert.match(turn as string, /"index": 2/);
		assert.doesNotMatch(turn as string, /"index": 0/);
		assert.match(turn as string, /refute/);
	});

	it('custom Verifier Instructions lead the turn', async () => {
		const { calls } = await exec({
			params: verifying({ instructions: 'Only keep claims you can prove.' }),
			streams: [{ messages: mainRun() }, { messages: verifierRun({ keep: [0, 1, 2], drop: [] }) }],
		});
		const [turn] = await drainPrompt(calls[1]);
		assert.ok((turn as string).startsWith('Only keep claims you can prove.\n\n'));
	});

	it('the verifier run keeps the main run’s options and carries no orchestration instruction', async () => {
		const subagent = {
			[SUBAGENT_TAG]: 1,
			name: 'reviewer',
			definition: { description: 'reviews', prompt: 'You review.' },
		};
		const { calls, optionsOf } = await exec({
			params: {
				...verifying(),
				subagentOrchestration: 'required',
				options: { maxBudgetUsd: 2 },
			},
			connections: { ai_agent: [subagent] },
			streams: [{ messages: mainRun() }, { messages: verifierRun({ keep: [0, 1, 2], drop: [] }) }],
		});
		for (const key of ['model', 'maxTurns', 'maxBudgetUsd', 'permissionMode', 'settings', 'cwd']) {
			assert.deepEqual(optionsOf(1)[key], optionsOf(0)[key], key);
		}
		assert.deepEqual(Object.keys(optionsOf(1).agents ?? {}), ['reviewer']);
		const [mainTurn] = await drainPrompt(calls[0]);
		assert.match(JSON.stringify(mainTurn), /delegate to EVERY/);
		const [verifierTurn] = await drainPrompt(calls[1]);
		assert.doesNotMatch(verifierTurn as string, /delegate to EVERY/);
	});

	it('resumes the session id the main result reported, even after a keyed session was created', async () => {
		const uuid = toSessionUuid('ticket-42');
		const { optionsOf, calls } = await exec({
			params: { ...verifying(), sessionMode: 'resume', sessionKey: 'ticket-42' },
			streams: [
				{ messages: [init(), errorResult('error_during_execution', { num_turns: 0 })] },
				{
					messages: mainRun().map((m) =>
						'session_id' in m ? ({ ...m, session_id: uuid } as SDKMessage) : m,
					),
				},
				{ messages: verifierRun({ keep: [0, 1, 2], drop: [] }) },
			],
		});
		assert.equal(calls.length, 3);
		assert.equal(optionsOf(1).sessionId, uuid);
		assert.equal(optionsOf(2).resume, uuid);
	});

	it('an item the verifier did not judge is kept and listed as unjudged', async () => {
		const { json } = await exec({
			params: verifying(),
			streams: [
				{ messages: mainRun() },
				{ messages: verifierRun({ keep: [0], drop: [{ index: 2, reason: 'wrong' }] }) },
			],
		});
		assert.deepEqual(json.structured, answer([FINDINGS[0], FINDINGS[1]]));
		const v = verificationOf(json);
		assert.deepEqual(v.unjudged, [1]);
		assert.equal(v.kept, 2);
		assert.equal(v.dropped, 1);
	});

	it('a filter limits what is judged; unselected items are never removed', async () => {
		const { json } = await exec({
			params: verifying({ filterField: 'severity', filterValues: 'high' }),
			streams: [
				{ messages: mainRun() },
				{
					messages: verifierRun({
						keep: [],
						drop: [
							{ index: 0, reason: 'r0' },
							{ index: 2, reason: 'not selected' },
						],
					}),
				},
			],
		});
		assert.deepEqual(json.structured, answer([FINDINGS[1], FINDINGS[2]]));
		const v = verificationOf(json);
		assert.equal(v.checked, 2);
		assert.deepEqual(v.unjudged, [1]);
	});
});

describe('Claude Code Agent Verification — metrics', () => {
	it('cost and modelUsage from the verification, turns and duration summed, usage from the main run', async () => {
		const { json } = await exec({
			params: verifying(),
			streams: [{ messages: mainRun() }, { messages: verifierRun({ keep: [0, 1, 2], drop: [] }) }],
		});
		const metrics = metricsOf(json);
		assert.equal(metrics.total_cost_usd, 0.05);
		assert.equal(metrics.num_turns, 5);
		assert.equal(metrics.duration_ms, 8000);
		assert.deepEqual(metrics.usage, { input_tokens: 10, output_tokens: 300 });
		assert.deepEqual(metrics.modelUsage, {
			'claude-sonnet-5': model({ outputTokens: 420, costUSD: 0.05 }),
		});
		assert.equal(metrics.session_id, MAIN_SESSION);
		assert.equal(verificationOf(json).costUsd, 0.02);
	});

	it('the item points at the main session, not at the verifier’s fork', async () => {
		const FORK = '0f0f0f0f-1111-4222-8333-444455556666';
		const forked = verifierRun({ keep: [0, 1, 2], drop: [] }).map((m) =>
			'session_id' in m ? ({ ...m, session_id: FORK } as SDKMessage) : m,
		);
		const { json } = await exec({
			params: { ...verifying(), sessionMode: 'resume', sessionKey: 'ticket-42' },
			streams: [{ messages: mainRun() }, { messages: forked }],
		});
		assert.equal(metricsOf(json).session_id, MAIN_SESSION);
		assert.equal((json.diagnostics as IDataObject).sessionId, MAIN_SESSION);
		assert.equal(metricsOf(json).total_cost_usd, 0.05);
		assert.equal(verificationOf(json).costUsd, 0.02);
	});

	it('one usage report for the item, carrying the combined metrics', async () => {
		const { json, fake } = await exec({
			reporting: true,
			params: { ...verifying(), options: { reportUsageTo: 'wf-collector' } },
			streams: [{ messages: mainRun() }, { messages: verifierRun({ keep: [0, 1, 2], drop: [] }) }],
		});
		assert.equal(fake.workflowCalls.length, 1);
		const payload = fake.workflowCalls[0].payload as Record<string, unknown>;
		assert.equal(payload.run_key, 'exec-1:Claude Code Agent:0:0:1');
		assert.deepEqual(payload.metrics, json.metrics);
		assert.equal((payload.metrics as IDataObject).total_cost_usd, 0.05);
	});

	it('a created session still reports its not-found attempt, then one combined report', async () => {
		const { fake } = await exec({
			reporting: true,
			params: {
				...verifying(),
				sessionMode: 'resume',
				sessionKey: 'ticket-42',
				options: { reportUsageTo: 'wf-collector' },
			},
			streams: [
				{ messages: [init(), errorResult('error_during_execution', { num_turns: 0 })] },
				{ messages: mainRun() },
				{ messages: verifierRun({ keep: [0, 1, 2], drop: [] }) },
			],
		});
		assert.equal(fake.workflowCalls.length, 2);
		const last = fake.workflowCalls[1].payload as { metrics: IDataObject };
		assert.equal(last.metrics.total_cost_usd, 0.05);
		assert.equal(last.metrics.num_turns, 5);
	});

	it('a skipped verification leaves the metrics and the report as the main run’s', async () => {
		const plain = await exec({
			reporting: true,
			params: { options: { reportUsageTo: 'wf-collector' } },
			streams: [{ messages: mainRun(answer([])) }],
		});
		const skipped = await exec({
			reporting: true,
			params: { ...verifying(), options: { reportUsageTo: 'wf-collector' } },
			streams: [{ messages: mainRun(answer([])) }],
		});
		assert.deepEqual(skipped.json.metrics, plain.json.metrics);
		assert.equal(skipped.fake.workflowCalls.length, 1);
		assert.deepEqual(skipped.fake.workflowCalls[0].payload, plain.fake.workflowCalls[0].payload);
	});
});

describe('Claude Code Agent Verification — a failed check drops nothing', () => {
	const failedWith = async (verifier: FakeQueryOptions, params: ParamMap = {}) =>
		exec({ params: { ...verifying(), ...params }, streams: [{ messages: mainRun() }, verifier] });

	const assertKeptEverything = (json: IDataObject, reason: RegExp) => {
		assert.equal(json.success, true);
		assert.deepEqual(json.structured, answer());
		const v = verificationOf(json);
		assert.equal(v.status, 'failed');
		assert.match(v.reason as string, reason);
		assert.equal(v.checked, 3);
		assert.equal(v.kept, 3);
		assert.equal(v.dropped, 0);
		assert.deepEqual(v.droppedItems, []);
	};

	it('a verifier run that crashes', async () => {
		const { json } = await failedWith({
			messages: [init({ sessionId: MAIN_SESSION })],
			throwAfter: new Error('CLI crashed'),
		});
		assertKeptEverything(json, /verification run failed: CLI crashed/);
		assert.equal(verificationOf(json).costUsd, null);
		assert.equal(metricsOf(json).total_cost_usd, 0.03);
	});

	it('a verifier run that ends in prose, without the verdict', async () => {
		const { json } = await failedWith({
			messages: [init({ sessionId: MAIN_SESSION }), assistantText('All fine.'), successResult()],
		});
		assertKeptEverything(json, /without producing the structured output/);
	});

	it('a verifier run that exhausts its structured-output retries', async () => {
		const { json } = await failedWith({
			messages: [
				init({ sessionId: MAIN_SESSION }),
				errorResult('error_max_structured_output_retries', { total_cost_usd: 0.07 }),
			],
			throwAfter: new Error('Claude Code returned an error result'),
		});
		assertKeptEverything(json, /verification run failed/);
		assert.equal(verificationOf(json).costUsd, 0.04);
	});

	it('a verifier run that times out', async () => {
		const { json } = await failedWith(
			{ messages: [init({ sessionId: MAIN_SESSION })], hang: true },
			{ timeout: 1, options: { wrapUpGraceSeconds: 0 } },
		);
		assertKeptEverything(json, /timed out after 1s/);
	});

	it('a verdict that does not match its schema', async () => {
		const { json } = await failedWith({ messages: verifierRun({ keep: 'all' }) });
		assertKeptEverything(json, /did not match its schema/);
	});

	it('an Items Path that finds no array fails the check, not the item, with no second run', async () => {
		const { json, calls } = await exec({
			params: verifying({ itemsPath: 'summary' }),
			streams: [{ messages: mainRun() }],
		});
		assert.equal(calls.length, 1);
		assert.equal(json.success, true);
		const v = verificationOf(json);
		assert.equal(v.status, 'failed');
		assert.match(v.reason as string, /"summary".*found a string there/);
		assert.equal(v.costUsd, 0);
	});
});

describe('Claude Code Agent Verification — when there is nothing to verify', () => {
	it('an empty array skips the second run', async () => {
		const { json, calls } = await exec({
			params: verifying(),
			streams: [{ messages: mainRun(answer([])) }],
		});
		assert.equal(calls.length, 1);
		assert.deepEqual(verificationOf(json), {
			status: 'skipped',
			checked: 0,
			kept: 0,
			dropped: 0,
			unjudged: [],
			droppedItems: [],
			costUsd: 0,
		});
	});

	it('a filter that matches nothing skips the second run', async () => {
		const { json, calls } = await exec({
			params: verifying({ filterField: 'severity', filterValues: 'critical' }),
			streams: [{ messages: mainRun() }],
		});
		assert.equal(calls.length, 1);
		assert.equal(verificationOf(json).status, 'skipped');
		assert.deepEqual(json.structured, answer());
	});

	it('a main run without the structured object fails as before, with no verification run', async () => {
		const { error, calls } = await execExpectingThrow({
			params: verifying(),
			streams: [{ messages: [init(), assistantText('I could not.'), successResult()] }],
		});
		assert.equal(error.type, 'structured_output');
		assert.equal(calls.length, 1);
	});
});

describe('Claude Code Agent Verification — refused before anything runs', () => {
	it('Output Mode Text', async () => {
		const { error, calls } = await execExpectingThrow({
			params: { ...verifying(), outputMode: 'text' },
			streams: [{ messages: mainRun() }],
		});
		assert.ok(error instanceof NodeOperationError);
		assert.match(error.message, /Output Mode is Text/);
		assert.equal(calls.length, 0);
	});

	it('an empty Items Path', async () => {
		const { error, calls } = await execExpectingThrow({
			params: verifying({ itemsPath: '  ' }),
			streams: [{ messages: mainRun() }],
		});
		assert.match(error.message, /Items Path is empty/);
		assert.equal(calls.length, 0);
	});
});

describe('Claude Code Agent Verification — disabled changes nothing', () => {
	const cases: Array<[string, ParamMap, SDKMessage[]]> = [
		['JSON Schema', {}, mainRun()],
		['Text', { outputMode: 'text' }, mainRun()],
	];
	for (const [label, base, messages] of cases) {
		for (const verification of [{}, { enabled: false, itemsPath: 'findings' }]) {
			it(`${label}, verification ${JSON.stringify(verification)}: the item is byte-identical`, async () => {
				const without = await exec({
					params: { ...base, options: { includeTranscript: true } },
					streams: [{ messages }],
				});
				const withSetting = await exec({
					params: { ...base, verification, options: { includeTranscript: true } },
					streams: [{ messages }],
				});
				assert.equal(withSetting.calls.length, 1);
				assert.equal(JSON.stringify(withSetting.json), JSON.stringify(without.json));
				assert.equal('verification' in withSetting.json, false);
			});
		}
	}
});
