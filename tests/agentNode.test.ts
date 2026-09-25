import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { query as sdkQuery, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { NodeOperationError, type IDataObject } from 'n8n-workflow';
import { z } from 'zod/v4';
import { ClaudeCodeAgent, runAgentItems } from '../nodes/ClaudeCodeAgent/ClaudeCodeAgent.node';
import { toSessionUuid } from '../nodes/shared/session';
import { SUBAGENT_TAG, type SubagentInvocation } from '../nodes/shared/subagent';
import { createFakeContext, type ParamMap } from './helpers/executeFunctions';
import { createFakeQuery, type FakeQueryOptions } from './helpers/fakeQuery';
import {
	assistantText,
	assistantTool,
	errorResult,
	init,
	msg,
	SESSION,
	streams,
	successResult,
} from './helpers/sdkMessages';

type Options = Record<string, unknown> & {
	mcpServers?: Record<string, unknown>;
	allowedTools?: string[];
	agents?: Record<string, unknown>;
	outputFormat?: unknown;
	systemPrompt?: { append?: string };
	settings?: Record<string, unknown>;
	resume?: string;
	sessionId?: string;
};

type ExecOpts = {
	params?: ParamMap;
	connections?: Record<string, unknown>;
	continueOnFail?: boolean;
	stream?: FakeQueryOptions;
	/** One stream per query() call, in order; the last repeats. */
	streamsPerCall?: FakeQueryOptions[];
	reporting?: boolean;
};

const agentParams = (over: ParamMap = {}): ParamMap => ({
	prompt: 'Review the change.',
	model: 'sonnet',
	projectPath: '',
	effort: 'high',
	maxTurns: 5,
	timeout: 300,
	options: {},
	...over,
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

async function exec(opts: ExecOpts = {}) {
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
	const { fake: query, calls } = sequencedQuery(
		opts.streamsPerCall ?? [opts.stream ?? { messages: streams.success() }],
	);
	const result = await runAgentItems(fake.ctx, { query });
	const optionsOf = (i: number) => (calls[i] as { options: Options }).options;
	return { items: result[0], json: result[0][0]?.json as IDataObject, fake, calls, optionsOf };
}

async function execExpectingThrow(opts: ExecOpts) {
	let calls: unknown[] = [];
	let workflowCalls: unknown[] = [];
	const fake = createFakeContext({
		typeVersion: 1,
		nodeName: 'Claude Code Agent',
		params: agentParams(opts.params),
		connections: {
			ai_tool: undefined,
			ai_agent: undefined,
			ai_outputParser: undefined,
			...opts.connections,
		},
		...(opts.reporting ? { workflow: {} } : {}),
	});
	workflowCalls = fake.workflowCalls;
	const seq = sequencedQuery(
		opts.streamsPerCall ?? [opts.stream ?? { messages: streams.success() }],
	);
	calls = seq.calls;
	try {
		await runAgentItems(fake.ctx, { query: seq.fake });
	} catch (error) {
		return { error: error as NodeOperationError, calls, workflowCalls };
	}
	assert.fail('expected runAgentItems to throw');
}

const diagnosticsOf = (json: IDataObject) => json.diagnostics as Record<string, unknown>;

const subagent = (name: string, log?: (i: SubagentInvocation) => void) => ({
	[SUBAGENT_TAG]: 1,
	name,
	definition: { description: `${name} description`, prompt: `You are ${name}.` },
	...(log ? { log } : {}),
});

const tool = (name: string) => ({
	name,
	description: `The ${name} tool`,
	schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
	invoke: async () => 'ok',
});

const taskStarted = (taskId: string, subagentType: string) =>
	msg({
		type: 'system',
		subtype: 'task_started',
		task_id: taskId,
		tool_use_id: `toolu_${taskId}`,
		description: 'Review the diff',
		subagent_type: subagentType,
		prompt: 'Look at the diff and report risks.',
		session_id: SESSION,
	});

const taskNotification = (taskId: string) =>
	msg({
		type: 'system',
		subtype: 'task_notification',
		task_id: taskId,
		tool_use_id: `toolu_${taskId}`,
		status: 'completed',
		summary: 'Two risky changes.',
		usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4000 },
		session_id: SESSION,
	});

const structuredRun = (structured: unknown): SDKMessage[] => [
	init(),
	assistantTool('StructuredOutput'),
	assistantText('Done.'),
	successResult({ structured_output: structured }),
];

async function drainPrompt(call: unknown): Promise<unknown[]> {
	const prompt = (call as { prompt: AsyncIterable<{ message: { content: unknown } }> }).prompt;
	const turns: unknown[] = [];
	for await (const message of prompt) turns.push(message.message.content);
	return turns;
}

const SCHEMA = {
	type: 'object',
	properties: { summary: { type: 'string' } },
	required: ['summary'],
};

describe('ClaudeCodeAgent — the adapter onto runAgentItems', () => {
	it('exposes execute and the description', () => {
		const node = new ClaudeCodeAgent();
		assert.equal(typeof node.execute, 'function');
		assert.equal(node.description.name, 'claudeCodeAgent');
	});
});

describe('ClaudeCodeAgent — a plain run', () => {
	it('emits the v1.2 envelope without messages, structured or agent-only diagnostics', async () => {
		const { json, optionsOf } = await exec();
		assert.equal(json.result, 'pong');
		assert.equal(json.success, true);
		assert.equal(json.errorText, '');
		assert.equal(typeof json.metrics, 'object');
		assert.equal('messages' in json, false);
		assert.equal('structured' in json, false);
		const diagnostics = diagnosticsOf(json);
		for (const key of [
			'bridgedTools',
			'subagents',
			'instructions',
			'structuredOutput',
			'sessionState',
		]) {
			assert.equal(key in diagnostics, false, key);
		}
		assert.equal(optionsOf(0).resume, undefined);
		assert.equal(optionsOf(0).outputFormat, undefined);
	});

	it('Include Transcript adds messages', async () => {
		const { json } = await exec({ params: { options: { includeTranscript: true } } });
		assert.ok(Array.isArray(json.messages));
		assert.equal((json.messages as unknown[]).length, streams.success().length);
	});

	it('counts subagent delegations under both Agent and Task', async () => {
		const { json } = await exec({
			stream: {
				messages: [init(), assistantTool('Agent'), assistantTool('Task'), successResult()],
			},
		});
		assert.equal(diagnosticsOf(json).subagentToolUses, 2);
	});
});

describe('ClaudeCodeAgent — tools', () => {
	it('bridges connected tools as one MCP server and lists their wire names', async () => {
		const { json, optionsOf } = await exec({
			connections: { ai_tool: [tool('lookup_order'), tool('refund')] },
		});
		assert.deepEqual(diagnosticsOf(json).bridgedTools, [
			'mcp__n8n__lookup_order',
			'mcp__n8n__refund',
		]);
		assert.deepEqual(Object.keys(optionsOf(0).mcpServers ?? {}), ['n8n']);
		assert.ok(optionsOf(0).allowedTools?.includes('mcp__n8n__lookup_order'));
		assert.ok(optionsOf(0).allowedTools?.includes('mcp__n8n__refund'));
	});
});

describe('ClaudeCodeAgent — subagents', () => {
	it('hands them to the SDK sorted by name and reports each one', async () => {
		const { json, optionsOf } = await exec({
			connections: { ai_agent: [subagent('zeta'), subagent('alpha')] },
		});
		assert.deepEqual(Object.keys(optionsOf(0).agents ?? {}), ['alpha', 'zeta']);
		const report = diagnosticsOf(json).subagents as Array<{ name: string; invocations: number }>;
		assert.deepEqual(
			report.map((r) => [r.name, r.invocations]),
			[
				['alpha', 0],
				['zeta', 0],
			],
		);
	});

	it('duplicate names fail the item before anything is spawned', async () => {
		const { error, calls } = await execExpectingThrow({
			connections: { ai_agent: [subagent('reviewer'), subagent('reviewer')] },
		});
		assert.ok(error instanceof NodeOperationError);
		assert.match(error.message, /'reviewer'/);
		assert.equal(calls.length, 0);
	});

	it('calls each subagent’s log with its invocation, and a failing log changes nothing', async () => {
		const logged: SubagentInvocation[] = [];
		const { json } = await exec({
			connections: {
				ai_agent: [
					subagent('reviewer', (i) => logged.push(i)),
					subagent('tester', () => {
						throw new Error('log sink is down');
					}),
				],
			},
			stream: {
				messages: [
					init(),
					taskStarted('t1', 'reviewer'),
					taskStarted('t2', 'tester'),
					taskNotification('t1'),
					taskNotification('t2'),
					assistantText('pong'),
					successResult(),
				],
			},
		});
		assert.equal(json.success, true);
		assert.equal(logged.length, 1);
		assert.equal(logged[0].name, 'reviewer');
		assert.equal(logged[0].prompt, 'Look at the diff and report risks.');
		assert.equal(logged[0].summary, 'Two risky changes.');
		assert.equal(logged[0].totalTokens, 1200);
	});

	it('Required orchestration appends the instruction as the last text of the user turn', async () => {
		const { calls } = await exec({
			params: { subagentOrchestration: 'required' },
			connections: { ai_agent: [subagent('tester'), subagent('reviewer')] },
		});
		const [turn] = await drainPrompt(calls[0]);
		const blocks = turn as Array<{ type: string; text: string }>;
		assert.equal(blocks[0].text, 'Review the change.');
		const last = blocks[blocks.length - 1].text;
		assert.match(last, /delegate to EVERY/);
		assert.match(last, /- reviewer\n- tester/);
	});

	it('Auto orchestration leaves the prompt a plain string', async () => {
		const { calls } = await exec({ connections: { ai_agent: [subagent('reviewer')] } });
		assert.deepEqual(await drainPrompt(calls[0]), ['Review the change.']);
	});
});

describe('ClaudeCodeAgent — structured output', () => {
	it('JSON Schema mode sends the schema and emits the object as structured', async () => {
		const { json, optionsOf } = await exec({
			params: { outputMode: 'jsonSchema', jsonSchema: JSON.stringify(SCHEMA) },
			stream: { messages: structuredRun({ summary: 'fine' }) },
		});
		assert.deepEqual(optionsOf(0).outputFormat, { type: 'json_schema', schema: SCHEMA });
		assert.deepEqual(json.structured, { summary: 'fine' });
		assert.equal(json.result, 'pong');
		assert.deepEqual(diagnosticsOf(json).structuredOutput, { mode: 'jsonSchema', attempts: 1 });
	});

	it('an invalid schema fails the item before anything is spawned', async () => {
		const { error, calls } = await execExpectingThrow({
			params: { outputMode: 'jsonSchema', jsonSchema: '{ not json' },
		});
		assert.match(error.message, /not valid JSON/);
		assert.equal(calls.length, 0);
	});

	it('Output Parser mode sends the parser’s inner schema', async () => {
		const parser = {
			getSchema: () => z.object({ output: z.object({ verdict: z.string() }) }),
		};
		const { json, optionsOf } = await exec({
			params: { outputMode: 'outputParser' },
			connections: { ai_outputParser: parser },
			stream: { messages: structuredRun({ verdict: 'ship' }) },
		});
		const format = optionsOf(0).outputFormat as { schema: Record<string, unknown> };
		assert.deepEqual(Object.keys(format.schema.properties as object), ['verdict']);
		assert.deepEqual(json.structured, { verdict: 'ship' });
		assert.equal((diagnosticsOf(json).structuredOutput as { mode: string }).mode, 'outputParser');
	});

	const failures: Array<[string, SDKMessage[]]> = [
		['a success that gave up in prose', [init(), assistantText('I could not.'), successResult()]],
		[
			'the retry limit',
			[
				init(),
				assistantTool('StructuredOutput'),
				assistantTool('StructuredOutput'),
				errorResult('error_max_structured_output_retries'),
			],
		],
	];

	// The real SDK rejects right after yielding an error result ("Claude Code returned an error
	// result: …"), so the retry limit arrives as a result AND a run error.
	const exhausted: FakeQueryOptions = {
		messages: failures[1][1],
		throwAfter: new Error(
			'Claude Code returned an error result: Failed to provide valid structured output after 5 attempts',
		),
	};

	it('the retry limit followed by the SDK’s throw is still a structured_output failure', async () => {
		const { json } = await exec({
			continueOnFail: true,
			params: { outputMode: 'jsonSchema', jsonSchema: JSON.stringify(SCHEMA) },
			stream: exhausted,
		});
		const details = json.details as Record<string, unknown>;
		assert.equal(details.errorType, 'structured_output');
		assert.equal(typeof details.metrics, 'object');
	});

	it('the retry limit followed by the SDK’s throw throws a structured_output error', async () => {
		const { error } = await execExpectingThrow({
			params: { outputMode: 'jsonSchema', jsonSchema: JSON.stringify(SCHEMA) },
			stream: exhausted,
		});
		assert.ok(error instanceof NodeOperationError);
		assert.equal(error.type, 'structured_output');
	});

	for (const [label, messages] of failures) {
		it(`${label}: a structured_output failure item under Continue On Fail`, async () => {
			const { json } = await exec({
				continueOnFail: true,
				params: { outputMode: 'jsonSchema', jsonSchema: JSON.stringify(SCHEMA) },
				stream: { messages },
			});
			const details = json.details as Record<string, unknown>;
			assert.equal(details.errorType, 'structured_output');
			assert.match(json.error as string, /did not return the structured output/);
			assert.equal(typeof details.metrics, 'object');
			const diagnostics = details.diagnostics as Record<string, unknown>;
			assert.equal((diagnostics.structuredOutput as { mode: string }).mode, 'jsonSchema');
			assert.equal('structured' in json, false);
		});

		it(`${label}: a thrown structured_output error without it`, async () => {
			const { error } = await execExpectingThrow({
				params: { outputMode: 'jsonSchema', jsonSchema: JSON.stringify(SCHEMA) },
				stream: { messages },
			});
			assert.ok(error instanceof NodeOperationError);
			assert.equal(error.type, 'structured_output');
			assert.match(error.message, /did not return the structured output/);
		});
	}
});

describe('ClaudeCodeAgent — instruction files', () => {
	it('land in the preset append after the System Prompt; missing files are reported', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'agent-instructions-'));
		try {
			writeFileSync(join(dir, 'rules.md'), 'Flag every TODO.');
			const { json, optionsOf } = await exec({
				params: {
					projectPath: dir,
					instructionFiles: 'rules.md\nmissing.md',
					options: { systemPrompt: 'Be terse.' },
				},
			});
			assert.equal(
				optionsOf(0).systemPrompt?.append,
				'Be terse.\n\n<instructions file="rules.md">\nFlag every TODO.\n</instructions>',
			);
			assert.deepEqual(diagnosticsOf(json).instructions, {
				loaded: ['rules.md'],
				missing: ['missing.md'],
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('ClaudeCodeAgent — claude.ai connectors', () => {
	it('are disabled by default', async () => {
		const { optionsOf } = await exec();
		assert.equal(optionsOf(0).settings?.disableClaudeAiConnectors, true);
	});

	it('are left alone when allowed', async () => {
		const { optionsOf } = await exec({ params: { options: { allowClaudeAiConnectors: true } } });
		assert.equal(optionsOf(0).settings?.disableClaudeAiConnectors, undefined);
	});
});

describe('ClaudeCodeAgent — sessions', () => {
	const uuid = toSessionUuid('ticket-42');
	const notFound: FakeQueryOptions = {
		messages: [init(), errorResult('error_during_execution', { num_turns: 0 })],
	};

	it('Resume continues the session named by the key', async () => {
		const { json, calls, optionsOf } = await exec({
			params: { sessionMode: 'resume', sessionKey: 'ticket-42' },
		});
		assert.equal(calls.length, 1);
		assert.equal(optionsOf(0).resume, uuid);
		assert.equal(diagnosticsOf(json).sessionState, 'resumed');
	});

	it('a key with no session creates it under the key’s uuid', async () => {
		const { json, calls, optionsOf } = await exec({
			params: { sessionMode: 'resume', sessionKey: 'ticket-42' },
			streamsPerCall: [notFound, { messages: streams.success() }],
		});
		assert.equal(calls.length, 2);
		assert.equal(optionsOf(1).sessionId, uuid);
		assert.equal(optionsOf(1).resume, undefined);
		assert.equal(json.success, true);
		assert.equal(diagnosticsOf(json).sessionState, 'created');
	});

	it('neither resumable nor creatable fails, naming the key', async () => {
		const { error } = await execExpectingThrow({
			params: { sessionMode: 'resume', sessionKey: 'ticket-42' },
			streamsPerCall: [notFound, notFound],
		});
		assert.match(
			error.description ?? '',
			/could neither resume nor create the session for "ticket-42"/,
		);
	});

	it('Resume with an empty key fails before anything is spawned', async () => {
		const { error, calls } = await execExpectingThrow({
			params: { sessionMode: 'resume', sessionKey: '  ' },
		});
		assert.match(error.message, /Session ID or Key is empty/);
		assert.equal(calls.length, 0);
	});
});

describe('ClaudeCodeAgent — failures', () => {
	it('a run error becomes the 1.1+ failure item under Continue On Fail', async () => {
		const { json } = await exec({
			continueOnFail: true,
			stream: {
				messages: [init(), assistantText('partial')],
				throwAfter: new Error('CLI crashed'),
			},
		});
		assert.equal(json.error, 'CLI crashed');
		assert.equal((json.details as Record<string, unknown>).errorType, 'execution_error');
		assert.equal(typeof (json.details as Record<string, unknown>).diagnostics, 'object');
	});

	it('a timeout takes the existing timeout path', async () => {
		const { json } = await exec({
			continueOnFail: true,
			params: { timeout: 1, options: { wrapUpGraceSeconds: 0 } },
			stream: { messages: [init()], hang: true },
		});
		assert.match(json.error as string, /timed out|timeout/i);
		assert.equal(typeof json.details, 'object');
	});
});

describe('ClaudeCodeAgent — usage reporting', () => {
	const reporting = { options: { reportUsageTo: 'wf-collector' } };

	it('reports a successful run with the agent diagnostics', async () => {
		const { fake } = await exec({
			reporting: true,
			params: reporting,
			connections: { ai_tool: [tool('lookup_order')] },
		});
		assert.equal(fake.workflowCalls.length, 1);
		const call = fake.workflowCalls[0];
		assert.equal(call.workflowId, 'wf-collector');
		assert.equal(call.doNotWaitToFinish, true);
		const payload = call.payload as Record<string, unknown>;
		assert.equal(payload.process_name, 'Claude Code Agent');
		assert.equal(payload.run_key, 'exec-1:Claude Code Agent:0:1');
		assert.equal(typeof payload.metrics, 'object');
		assert.deepEqual((payload.diagnostics as Record<string, unknown>).bridgedTools, [
			'mcp__n8n__lookup_order',
		]);
	});

	it('reports a failed run, with and without Continue On Fail', async () => {
		const failing: FakeQueryOptions = {
			messages: [init(), successResult()],
			throwAfter: new Error('CLI crashed'),
		};
		const soft = await exec({
			reporting: true,
			continueOnFail: true,
			params: reporting,
			stream: failing,
		});
		assert.equal(soft.fake.workflowCalls.length, 1);

		const hard = await execExpectingThrow({ reporting: true, params: reporting, stream: failing });
		assert.equal(hard.workflowCalls.length, 1);
	});

	it('reports a structured-output failure and a timeout', async () => {
		const structured = await execExpectingThrow({
			reporting: true,
			params: { ...reporting, outputMode: 'jsonSchema', jsonSchema: JSON.stringify(SCHEMA) },
			stream: { messages: streams.success() },
		});
		assert.equal(structured.workflowCalls.length, 1);

		const timedOut = await exec({
			reporting: true,
			continueOnFail: true,
			params: { timeout: 1, options: { wrapUpGraceSeconds: 0, reportUsageTo: 'wf-collector' } },
			stream: { messages: [init()], hang: true },
		});
		assert.equal(timedOut.fake.workflowCalls.length, 1);
	});

	it('reports both runs when a session had to be created', async () => {
		const { fake } = await exec({
			reporting: true,
			params: { ...reporting, sessionMode: 'resume', sessionKey: 'ticket-42' },
			streamsPerCall: [
				{ messages: [init(), errorResult('error_during_execution', { num_turns: 0 })] },
				{ messages: streams.success() },
			],
		});
		assert.deepEqual(
			fake.workflowCalls.map((c) => (c.payload as { run_key: string }).run_key),
			['exec-1:Claude Code Agent:0:1', 'exec-1:Claude Code Agent:0:2'],
		);
		const last = fake.workflowCalls[1].payload as { diagnostics: Record<string, unknown> };
		assert.equal(last.diagnostics.sessionState, 'created');
	});

	it('nothing is reported when no workflow is chosen, and nothing before a run', async () => {
		const { fake } = await exec({ reporting: true });
		assert.equal(fake.workflowCalls.length, 0);
		const refused = await execExpectingThrow({
			reporting: true,
			params: { ...reporting, outputMode: 'jsonSchema', jsonSchema: '' },
		});
		assert.equal(refused.workflowCalls.length, 0);
	});
});
