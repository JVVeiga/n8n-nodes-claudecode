import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { runAgentItems } from '../nodes/ClaudeCodeAgent/ClaudeCodeAgent.node';
import {
	ClaudeCodeSubagent,
	supplySubagent,
} from '../nodes/ClaudeCodeSubagent/ClaudeCodeSubagent.node';
import { claudeCodeSubagentDescription } from '../nodes/ClaudeCodeSubagent/description';
import { isSuppliedSubagent, type SuppliedSubagent } from '../nodes/shared/subagent';
import { subagentRunLog } from '../nodes/shared/subagentLog';
import { createFakeContext, type ParamMap } from './helpers/executeFunctions';
import { createFakeQuery } from './helpers/fakeQuery';
import { assistantText, init, msg, SESSION, successResult } from './helpers/sdkMessages';
import { createFakeSupplyContext } from './helpers/supplyDataFunctions';

const subagentParams = (over: ParamMap = {}): ParamMap => ({
	agentName: 'code-reviewer',
	whenToUse: 'Reviews a diff for risky changes.',
	instructions: 'You review diffs.',
	model: 'inherit',
	options: {},
	...over,
});

function supply(over: ParamMap = {}, ctxOptions: { addInputDataThrows?: boolean } = {}) {
	const fake = createFakeSupplyContext({
		nodeName: 'Code Reviewer',
		params: subagentParams(over),
		...ctxOptions,
	});
	const subagent = supplySubagent(fake.supplyCtx, 0).response as SuppliedSubagent;
	return { fake, subagent };
}

const invocation = {
	name: 'code-reviewer',
	description: 'Review the diff',
	prompt: 'Look at the diff and report risks.',
	status: 'completed',
	summary: 'Two risky changes.',
	totalTokens: 1200,
	toolUses: 3,
	durationMs: 4000,
};

describe('Claude Code Subagent — the definition', () => {
	it('builds every AgentDefinition field from the parameters', () => {
		const { subagent } = supply({
			agentName: '  code-reviewer ',
			model: 'opus',
			options: {
				effort: 'xhigh',
				maxTurns: 7,
				tools: ['Read', 'Grep'],
				extraTools: ' mcp__n8n__search_docs , Read,, ',
				disallowedTools: 'Bash, Write ,Bash',
				omitClaudeMd: true,
			},
		});
		assert.equal(subagent.name, 'code-reviewer');
		assert.deepEqual(subagent.definition, {
			description: 'Reviews a diff for risky changes.',
			prompt: 'You review diffs.',
			model: 'opus',
			effort: 'xhigh',
			maxTurns: 7,
			tools: ['Read', 'Grep', 'mcp__n8n__search_docs'],
			disallowedTools: ['Bash', 'Write'],
			omitClaudeMd: true,
		});
	});

	it('inherit keeps the SDK’s model value and omits every other inherited field', () => {
		const { subagent } = supply({
			options: { effort: 'inherit', maxTurns: 0, tools: [], extraTools: ' ', omitClaudeMd: false },
		});
		assert.deepEqual(subagent.definition, {
			description: 'Reviews a diff for risky changes.',
			prompt: 'You review diffs.',
			model: 'inherit',
		});
	});

	it('an empty options collection yields the minimal definition', () => {
		const { subagent } = supply();
		assert.deepEqual(Object.keys(subagent.definition).sort(), ['description', 'model', 'prompt']);
	});

	it('the response passes isSuppliedSubagent and carries a log', () => {
		const { subagent } = supply();
		assert.equal(isSuppliedSubagent(subagent), true);
		assert.equal(typeof subagent.log, 'function');
	});

	for (const bad of ['Code-Reviewer', 'code reviewer', '-reviewer', 'reviewer_1', '']) {
		it(`rejects the name '${bad}' with the name in the message`, () => {
			const fake = createFakeSupplyContext({ params: subagentParams({ agentName: bad }) });
			assert.throws(
				() => supplySubagent(fake.supplyCtx, 0),
				(error: unknown) =>
					error instanceof NodeOperationError && error.message.includes(`'${bad}'`),
			);
		});
	}

	it('rejects an empty When to Use or Instructions', () => {
		for (const over of [{ whenToUse: '  ' }, { instructions: '' }]) {
			const fake = createFakeSupplyContext({ params: subagentParams(over) });
			assert.throws(() => supplySubagent(fake.supplyCtx, 0), NodeOperationError);
		}
	});

	it('supplyData on the class goes through the same seam', async () => {
		const fake = createFakeSupplyContext({ params: subagentParams() });
		const data = await new ClaudeCodeSubagent().supplyData.call(fake.supplyCtx, 0);
		assert.equal(isSuppliedSubagent(data.response), true);
	});
});

describe('Claude Code Subagent — the run log', () => {
	it('writes the delegation as input and the report as output on ai_agent', () => {
		const { fake, subagent } = supply();
		subagent.log?.(invocation);
		assert.deepEqual(fake.runData, [
			{
				direction: 'input',
				index: 0,
				payload: [[{ json: { prompt: invocation.prompt, description: invocation.description } }]],
			},
			{
				direction: 'output',
				index: 0,
				payload: [
					[
						{
							json: {
								status: 'completed',
								summary: 'Two risky changes.',
								totalTokens: 1200,
								toolUses: 3,
								durationMs: 4000,
							},
						},
					],
				],
			},
		]);
	});

	it('uses the ai_agent connection type for both calls', () => {
		const types: string[] = [];
		const ctx = {
			addInputData: (type: string) => {
				types.push(type);
				return { index: 0 };
			},
			addOutputData: (type: string) => {
				types.push(type);
			},
		} as unknown as Parameters<typeof subagentRunLog>[0];
		subagentRunLog(ctx)(invocation);
		assert.deepEqual(types, ['ai_agent', 'ai_agent']);
	});

	it('records a status other than completed as output, not as an error', () => {
		const { fake, subagent } = supply();
		subagent.log!({ ...invocation, status: 'failed', summary: null, totalTokens: null });
		const output = fake.runData[1].payload as Array<Array<{ json: IDataObject }>>;
		assert.equal(output[0][0].json.status, 'failed');
		assert.equal(output[0][0].json.summary, null);
	});

	it('is a no-op when addInputData throws', () => {
		const { fake, subagent } = supply({}, { addInputDataThrows: true });
		assert.doesNotThrow(() => subagent.log!(invocation));
		assert.deepEqual(fake.runData, []);
	});

	it('swallows a failing addOutputData', () => {
		const ctx = {
			addInputData: () => ({ index: 0 }),
			addOutputData: () => {
				throw new Error('run data refused');
			},
		} as unknown as Parameters<typeof subagentRunLog>[0];
		assert.doesNotThrow(() => subagentRunLog(ctx)(invocation));
	});
});

describe('Claude Code Subagent — description', () => {
	const d = claudeCodeSubagentDescription;

	it('is a sub-node with no inputs and one ai_agent output', () => {
		assert.equal(d.name, 'claudeCodeSubagent');
		assert.equal(d.displayName, 'Claude Code Subagent');
		assert.equal(d.version, 1);
		assert.deepEqual(d.inputs, []);
		assert.deepEqual(d.outputs, [{ type: 'ai_agent' }]);
		assert.deepEqual(d.outputNames, ['Subagent']);
		assert.equal(d.icon, 'file:claudecode.svg');
		assert.equal(d.credentials, undefined);
	});

	it('defaults Model and Effort to inherit, Max Turns to 0', () => {
		const model = d.properties.find((p) => p.name === 'model');
		assert.equal(model?.default, 'inherit');
		const options = (d.properties.find((p) => p.name === 'options')?.options ??
			[]) as INodeProperties[];
		const option = (name: string) => options.find((o) => o.name === name);
		assert.equal(option('effort')?.default, 'inherit');
		assert.equal(option('maxTurns')?.default, 0);
		assert.equal(option('omitClaudeMd')?.default, false);
		assert.deepEqual(
			options.map((o) => o.name),
			['extraTools', 'tools', 'disallowedTools', 'effort', 'maxTurns', 'omitClaudeMd'],
		);
	});

	it('offers exactly the SDK’s named effort levels plus inherit', () => {
		const options = d.properties.find((p) => p.name === 'options')?.options as INodeProperties[];
		const effort = options.find((o) => o.name === 'effort');
		const values = (effort?.options as Array<{ value: string }>).map((o) => o.value);
		assert.deepEqual(values, ['inherit', 'low', 'medium', 'high', 'xhigh', 'max']);
	});

	it('is registered in package.json and ships its codex and icon', () => {
		const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
		assert.ok(pkg.n8n.nodes.includes('dist/nodes/ClaudeCodeSubagent/ClaudeCodeSubagent.node.js'));
		const dir = join(process.cwd(), 'nodes', 'ClaudeCodeSubagent');
		assert.ok(existsSync(join(dir, 'claudecode.svg')));
		const codex = JSON.parse(readFileSync(join(dir, 'ClaudeCodeSubagent.node.json'), 'utf8'));
		assert.equal(codex.node, '@joaoveiga/n8n-nodes-claudecode.claudeCodeSubagent');
	});

	it('only params.ts calls getNodeParameter', () => {
		const dir = join(process.cwd(), 'nodes', 'ClaudeCodeSubagent');
		const readers = readdirSync(dir)
			.filter((f) => f.endsWith('.ts'))
			.filter((f) => /\.getNodeParameter\(/.test(readFileSync(join(dir, f), 'utf8')));
		assert.deepEqual(readers, ['params.ts']);
	});
});

describe('Claude Code Subagent — through the Agent', () => {
	it('a delegation reported by the run lands on the sub-node’s own log', async () => {
		const { fake: subCtx, subagent } = supply();
		const agentCtx = createFakeContext({
			typeVersion: 1,
			nodeName: 'Claude Code Agent',
			params: {
				prompt: 'Review the change.',
				model: 'sonnet',
				projectPath: '',
				effort: 'high',
				maxTurns: 5,
				timeout: 300,
				options: {},
			},
			connections: { ai_tool: undefined, ai_agent: [subagent], ai_outputParser: undefined },
		});
		const handle = createFakeQuery({
			messages: [
				init(),
				msg({
					type: 'system',
					subtype: 'task_started',
					task_id: 't1',
					tool_use_id: 'toolu_t1',
					description: 'Review the diff',
					subagent_type: 'code-reviewer',
					prompt: 'Look at the diff and report risks.',
					session_id: SESSION,
				}),
				msg({
					type: 'system',
					subtype: 'task_notification',
					task_id: 't1',
					tool_use_id: 'toolu_t1',
					status: 'completed',
					summary: 'Two risky changes.',
					usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4000 },
					session_id: SESSION,
				}),
				assistantText('Done.'),
				successResult(),
			],
		});

		const result = await runAgentItems(agentCtx.ctx, { query: handle.fake });

		assert.equal(result[0][0].json.success, true);
		const options = (handle.record.calls[0] as { options: { agents?: Record<string, unknown> } })
			.options;
		assert.deepEqual(options.agents, { 'code-reviewer': subagent.definition });
		assert.deepEqual(
			subCtx.runData.map((e) => [e.direction, e.index]),
			[
				['input', 0],
				['output', 0],
			],
		);
		const input = subCtx.runData[0].payload as Array<Array<{ json: IDataObject }>>;
		const output = subCtx.runData[1].payload as Array<Array<{ json: IDataObject }>>;
		assert.equal(input[0][0].json.prompt, 'Look at the diff and report risks.');
		assert.equal(output[0][0].json.summary, 'Two risky changes.');
		assert.equal(output[0][0].json.totalTokens, 1200);
	});
});
