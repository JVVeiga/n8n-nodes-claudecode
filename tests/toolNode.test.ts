import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeTool, supplyClaudeCodeTool } from '../nodes/ClaudeCodeTool/ClaudeCodeTool.node';
import { toToolName } from '../nodes/shared/toolRunLog';
import { buildClaudeCodeTaskTool, TASK_TOOL_SCHEMA } from '../nodes/ClaudeCodeTool/tool';
import type { DebugLogger } from '../nodes/shared/debug';
import type { ClaudeCodeParams } from '../nodes/ClaudeCode/types';
import { createFakeSupplyContext } from './helpers/supplyDataFunctions';

const msg = (value: unknown): SDKMessage => value as SDKMessage;

const happyRun = (text: string) => [
	msg({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-sonnet-5' }),
	msg({
		type: 'assistant',
		session_id: 's-1',
		message: { content: [{ type: 'text', text }] },
	}),
	msg({
		type: 'result',
		subtype: 'success',
		result: text,
		session_id: 's-1',
		total_cost_usd: 0.01,
		num_turns: 1,
		modelUsage: {
			'claude-sonnet-5': {
				inputTokens: 10,
				outputTokens: 5,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			},
		},
	}),
];

const script = (messages: SDKMessage[], seen: unknown[] = []): typeof sdkQuery =>
	((input: { prompt: AsyncIterable<{ message?: { content?: unknown } }>; options: unknown }) => {
		const generator = (async function* () {
			const first = await input.prompt[Symbol.asyncIterator]().next();
			seen.push({ options: input.options, prompt: first.value?.message?.content });
			for (const message of messages) yield message;
		})();
		return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
	}) as unknown as typeof sdkQuery;

const noopDebug: DebugLogger = { enabled: false, log: () => {}, lazy: () => {}, error: () => {} };

const params = (over: Partial<ClaudeCodeParams> = {}): ClaudeCodeParams => ({
	operation: 'query',
	sessionId: '',
	prompt: '',
	model: 'claude-sonnet-5',
	effort: 'high',
	maxTurns: 5,
	timeoutSeconds: 300,
	projectPath: '',
	outputFormat: 'text',
	allowedTools: [],
	disallowedTools: [],
	restrictTools: [],
	attachments: {
		all: false,
		names: [],
		inlineTextLimitKb: 256,
		maxAttachmentMb: 50,
		maxAttachmentCount: 16,
		allowedExtensions: [],
	},
	additional: { wrapUpGraceSeconds: 60 },
	nodeVersion: 1,
	itemIndex: 0,
	...over,
});

const toolDeps = (over: Record<string, unknown> = {}) => ({
	name: 'Claude_Code_Task',
	description: 'Runs a task',
	params: params(),
	auth: { mode: 'host' as const },
	query: script(happyRun('done: 42')),
	debug: noopDebug,
	processEnv: { PATH: '/usr/bin' },
	...over,
});

describe('buildClaudeCodeTaskTool — the contract the Agent sees', () => {
	it('offers JSON Schema with ONE self-describing argument — never a zod object', () => {
		const tool = buildClaudeCodeTaskTool(toolDeps());
		assert.equal(tool.name, 'Claude_Code_Task');
		assert.equal(tool.description, 'Runs a task');
		// Measured: n8n's normalizeToolSchema tests `instanceof ZodType` against ITS zod copy,
		// which an instance from ours never satisfies — it then mangles it through
		// convertJsonSchemaToZod into a ZodDefault and the tool call fails before the handler
		// runs (case66's first red). Plain JSON Schema puts n8n on its own happy path.
		assert.deepEqual(tool.schema, TASK_TOOL_SCHEMA);
		assert.equal(
			typeof (tool.schema as { safeParse?: unknown }).safeParse,
			'undefined',
			'must NOT be a zod schema',
		);
	});

	it('the task becomes the prompt, and the result text comes back', async () => {
		const seen: Array<{ prompt?: unknown }> = [];
		const tool = buildClaudeCodeTaskTool(toolDeps({ query: script(happyRun('done: 42'), seen) }));
		const output = await tool.invoke({ task: 'count the files' });
		assert.equal(output, 'done: 42');
		assert.equal(seen[0].prompt, 'count the files');
	});

	it('a configuration problem returns TEXT, never a throw — the model can react', async () => {
		const tool = buildClaudeCodeTaskTool(
			toolDeps({
				params: params({ model: 'sonnet', additional: { fallbackModel: 'sonnet' } }),
			}),
		);
		const output = await tool.invoke({ task: 'x' });
		assert.match(String(output), /Configuration error: Fallback Model/);
	});

	it('a run error returns text too', async () => {
		const failing = ((input: { prompt: AsyncIterable<unknown> }) => {
			const generator = (async function* () {
				await input.prompt[Symbol.asyncIterator]().next();
				yield happyRun('')[0];
				throw new Error('spawn failed');
			})();
			return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
		}) as unknown as typeof sdkQuery;
		const tool = buildClaudeCodeTaskTool(toolDeps({ query: failing }));
		const output = await tool.invoke({ task: 'x' });
		assert.match(String(output), /Claude Code failed: spawn failed/);
	});
});

describe('the node — description and supplyData', () => {
	const description = new ClaudeCodeTool().description;

	it('is an ai_tool sub-node named claudeCodeTaskTool — NOT the auto-wrap name', () => {
		assert.deepEqual(description.inputs, []);
		assert.deepEqual(description.outputs, [{ type: 'ai_tool' }]);
		assert.equal(description.name, 'claudeCodeTaskTool');
	});

	it('R10: a task run writes the input/output pair into the sub-node’s log', async () => {
		const fake = createFakeSupplyContext({
			params: {
				toolDescription: 'x',
				model: 'claude-sonnet-5',
				authSource: 'host',
				projectPath: '',
				options: {},
			},
		});
		const supplied = await supplyClaudeCodeTool(
			fake.supplyCtx,
			{ query: script(happyRun('counted: 6')) },
			0,
		);
		const tool = supplied.response as { invoke: (v: unknown) => Promise<string> };
		await tool.invoke({ task: 'count files' });

		assert.equal(fake.runData.length, 2);
		assert.equal(fake.runData[0].direction, 'input');
		const input = (fake.runData[0].payload as Array<Array<{ json: Record<string, unknown> }>>)[0][0]
			.json;
		assert.equal(input.task, 'count files');
		const output = (
			fake.runData[1].payload as Array<Array<{ json: Record<string, unknown> }>>
		)[0][0].json;
		assert.equal(output.response, 'counted: 6');
	});

	it('supplies the tool, named after the node, described by the parameter', async () => {
		const fake = createFakeSupplyContext({
			params: {
				toolDescription: '  Counts things in /workspace  ',
				model: 'claude-sonnet-5',
				authSource: 'host',
				projectPath: '',
				options: {},
			},
			nodeName: 'Repo Inspector',
		});
		const supplied = await supplyClaudeCodeTool(
			fake.supplyCtx,
			{ query: script(happyRun('ok')) },
			0,
		);
		const tool = supplied.response as { name: string; description: string };
		assert.equal(tool.name, 'Repo_Inspector');
		assert.equal(tool.description, 'Counts things in /workspace');
	});

	it('a credential mode with nothing selected fails in supplyData, before the Agent runs', async () => {
		const fake = createFakeSupplyContext({
			params: {
				toolDescription: 'x',
				model: 'claude-sonnet-5',
				authSource: 'apiKey',
				projectPath: '',
				options: {},
			},
		});
		await assert.rejects(
			supplyClaudeCodeTool(fake.supplyCtx, { query: script([]) }, 0),
			/No credential selected/,
		);
	});
});

describe('toToolName', () => {
	it('derives an MCP-safe wire name from the canvas name', () => {
		assert.equal(toToolName('Repo Inspector'), 'Repo_Inspector');
		assert.equal(toToolName('  weird!! name  '), 'weird___name');
		// `.` is excluded: Anthropic tool names must match ^[a-zA-Z0-9_-]+$, so a node called
		// "Claude Code v1.2" would otherwise produce a name the API rejects outright.
		assert.equal(toToolName('Claude Code v1.2'), 'Claude_Code_v1_2');
		assert.equal(toToolName(''), 'Claude_Code_Tool', 'default fallback');
		assert.equal(toToolName('', 'Claude_Code_Task'), 'Claude_Code_Task', 'caller can name it');
	});
});
