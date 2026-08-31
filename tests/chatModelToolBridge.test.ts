import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod/v4';
import {
	bridgedToolName,
	buildToolBridge,
	planTool,
	runBindableTool,
	MCP_SERVER_NAME,
	type BindableTool,
} from '../nodes/ClaudeCodeChatModel/toolBridge';

/**
 * The Option B bridge (DEC-CM1). The schemas below mirror what spike S2 measured: structured
 * tools arrive with a zod object (n8n converts JSON schema to zod before the model sees it),
 * string tools arrive schema-less or with an opaque transform.
 */

const invokeNever = async () => {
	throw new Error('not called in this test');
};

describe('planTool — schema round-trip (K3)', () => {
	it('a zod object schema survives: types, required/optional, descriptions', () => {
		const planned = planTool({
			name: 'lookup',
			description: 'Look something up',
			schema: z.object({
				query: z.string().describe('what to search'),
				limit: z.number().optional(),
				exact: z.boolean(),
			}),
			invoke: invokeNever,
		});

		assert.equal(planned.stringInput, false);
		assert.deepEqual(Object.keys(planned.shape).sort(), ['exact', 'limit', 'query']);
		const parsed = z.object(planned.shape).safeParse({ query: 'x', exact: true });
		assert.equal(parsed.success, true, 'limit is optional');
		const missing = z.object(planned.shape).safeParse({ exact: true });
		assert.equal(missing.success, false, 'query is required');
	});

	it('a plain JSON schema (never zod) is accepted as-is', () => {
		const planned = planTool({
			name: 'calc',
			schema: {
				type: 'object',
				properties: {
					expression: { type: 'string', description: 'the expression' },
					mode: { type: 'string', enum: ['a', 'b'] },
					values: { type: 'array', items: { type: 'number' } },
				},
				required: ['expression'],
			},
			invoke: invokeNever,
		});

		assert.equal(planned.stringInput, false);
		const schema = z.object(planned.shape);
		assert.equal(schema.safeParse({ expression: '1+1', mode: 'a', values: [1, 2] }).success, true);
		assert.equal(schema.safeParse({ expression: '1+1', mode: 'zzz' }).success, false, 'enum holds');
		assert.equal(schema.safeParse({}).success, false, 'required holds');
	});

	it('a schema-less tool degrades to string input rather than vanishing', () => {
		const planned = planTool({ name: 'plain', invoke: invokeNever });
		assert.equal(planned.stringInput, true);
		assert.deepEqual(Object.keys(planned.shape), ['input']);
	});

	it('an opaque schema (a bare zod string, like DynamicTool ships) also degrades to string input', () => {
		const planned = planTool({ name: 'raw', schema: z.string(), invoke: invokeNever });
		assert.equal(planned.stringInput, true);
	});

	it('a ZERO-argument node-as-tool (empty object schema) stays structured — exec 88 regression', async () => {
		// n8n's usableAsTool nodes with no $fromAI args ship z.object({}). String mode here made
		// the tool reject its own input before running.
		const calls: unknown[] = [];
		const tool: BindableTool = {
			name: 'usage',
			schema: { type: 'object', properties: {} },
			invoke: async (input) => {
				calls.push(input);
				return { plan: 'max' };
			},
		};
		const planned = planTool(tool);
		assert.equal(planned.stringInput, false);
		assert.deepEqual(planned.shape, {});

		const zodVariant = planTool({ name: 'usage2', schema: z.object({}), invoke: invokeNever });
		assert.equal(zodVariant.stringInput, false, 'the zod flavour of the same schema too');

		const result = await runBindableTool(planned, tool, {});
		assert.deepEqual(calls, [{}], 'invoked with the args object, not a string');
		assert.equal(result.isError, undefined);
		assert.match((result.content[0] as { text: string }).text, /plan/);
	});
});

describe('runBindableTool — the handler (R5)', () => {
	it('invokes the tool with the args object and returns its output as text', async () => {
		const calls: unknown[] = [];
		const tool: BindableTool = {
			name: 'calc',
			schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
			invoke: async (input) => {
				calls.push(input);
				return (input as { x: number }).x * 2;
			},
		};
		const result = await runBindableTool(planTool(tool), tool, { x: 21 });
		assert.deepEqual(calls, [{ x: 21 }]);
		assert.deepEqual(result.content, [{ type: 'text', text: '42' }]);
		assert.equal(result.isError, undefined);
	});

	it('unwraps string-input tools: the tool receives the bare string', async () => {
		const calls: unknown[] = [];
		const tool: BindableTool = {
			name: 'plain',
			invoke: async (input) => {
				calls.push(input);
				return 'ok';
			},
		};
		await runBindableTool(planTool(tool), tool, { input: 'the query' });
		assert.deepEqual(calls, ['the query']);
	});

	it('a thrown error becomes isError — never a crashed run — and is reported', async () => {
		const reported: string[] = [];
		const tool: BindableTool = {
			name: 'bad',
			invoke: async () => {
				throw new Error('boom');
			},
		};
		const result = await runBindableTool(planTool(tool), tool, { input: 'x' }, (name) =>
			reported.push(name),
		);
		assert.equal(result.isError, true);
		assert.match((result.content[0] as { text: string }).text, /Tool bad failed: boom/);
		assert.deepEqual(reported, ['bad']);
	});
});

describe('buildToolBridge — what config.ts receives', () => {
	it('returns null for no tools: no server, no applier fires', () => {
		assert.equal(buildToolBridge([]), null);
	});

	it('one sdk server named n8n, tool names fully qualified', () => {
		const bridge = buildToolBridge([
			{ name: 'calculator', invoke: invokeNever },
			{ name: 'get_weather', invoke: invokeNever },
		]);
		assert.ok(bridge);
		assert.deepEqual(Object.keys(bridge.servers), [MCP_SERVER_NAME]);
		const server = bridge.servers[MCP_SERVER_NAME] as { type: string; name: string };
		assert.equal(server.type, 'sdk');
		assert.deepEqual(bridge.toolNames, ['mcp__n8n__calculator', 'mcp__n8n__get_weather']);
	});

	it('bridgedToolName matches the SDK naming scheme the run will see', () => {
		assert.equal(bridgedToolName('calculator'), 'mcp__n8n__calculator');
	});
});
