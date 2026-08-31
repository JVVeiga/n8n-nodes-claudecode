import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	ClaudeCodeUsageTool,
	supplyClaudeCodeUsageTool,
} from '../nodes/ClaudeCodeUsageTool/ClaudeCodeUsageTool.node';
import type { readUsage } from '../nodes/ClaudeCodeUsage/readUsage';
import { createFakeSupplyContext } from './helpers/supplyDataFunctions';

/**
 * The escalation logic and the normalisers are covered by the Usage node's own suites; here the
 * contract under test is the TOOL: zero-argument schema, node-derived name, text-out failures,
 * and the injected reader actually being used.
 */

const fakeRead = (payload: Record<string, unknown>): typeof readUsage =>
	(async () => ({
		init: {
			apiKeySource: null,
			tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN',
		},
		usage: payload,
		claudeCodeVersion: '2.1.251',
		initMs: 5,
		usageMs: 7,
		unsupported: false,
		probeCostUsd: null,
	})) as unknown as typeof readUsage;

const WINDOWS = {
	rate_limits: {
		five_hour: { utilization: 73, resets_at: '2026-08-31T03:00:00+00:00' },
		seven_day: { utilization: 62, resets_at: '2026-09-01T20:00:00+00:00' },
	},
};

const usageToolParams = (over: Record<string, unknown> = {}) => ({
	toolDescription: 'Reads plan usage',
	authSource: 'host',
	options: {},
	...over,
});

describe('Claude Code Usage Tool — the contract the Agent sees', () => {
	const description = new ClaudeCodeUsageTool().description;

	it('is an ai_tool sub-node named claudeCodePlanUsageTool — NOT the auto-wrap name', () => {
		assert.deepEqual(description.inputs, []);
		assert.deepEqual(description.outputs, [{ type: 'ai_tool' }]);
		assert.equal(description.name, 'claudeCodePlanUsageTool');
	});

	it('supplies a ZERO-argument tool named after the node, schema as JSON Schema', async () => {
		const fake = createFakeSupplyContext({
			params: usageToolParams(),
			nodeName: 'Plan Usage',
		});
		const supplied = await supplyClaudeCodeUsageTool(
			fake.supplyCtx,
			{ readUsage: fakeRead(WINDOWS) },
			0,
		);
		const tool = supplied.response as { name: string; description: string; schema: unknown };
		assert.equal(tool.name, 'Plan_Usage');
		assert.equal(tool.description, 'Reads plan usage');
		// JSON Schema, not zod — see the task tool's test for the measured reason.
		assert.deepEqual(tool.schema, { type: 'object', properties: {} });
	});

	it('R10: a read writes the input/output pair into the sub-node’s log', async () => {
		const fake = createFakeSupplyContext({ params: usageToolParams() });
		const supplied = await supplyClaudeCodeUsageTool(
			fake.supplyCtx,
			{ readUsage: fakeRead(WINDOWS) },
			0,
		);
		const tool = supplied.response as { invoke: (v: unknown) => Promise<string> };
		await tool.invoke({});
		assert.equal(fake.runData.length, 2);
		assert.equal(fake.runData[0].direction, 'input');
		assert.equal(fake.runData[1].direction, 'output');
	});

	it('invoke({}) returns the normalised report as JSON text', async () => {
		const fake = createFakeSupplyContext({ params: usageToolParams() });
		const supplied = await supplyClaudeCodeUsageTool(
			fake.supplyCtx,
			{ readUsage: fakeRead(WINDOWS) },
			0,
		);
		const tool = supplied.response as { invoke: (v: unknown) => Promise<string> };
		const output = await tool.invoke({});
		const report = JSON.parse(output) as {
			authenticated: boolean;
			windows: Array<{ key: string; utilization: number | null }>;
		};
		assert.equal(report.authenticated, true);
		const fiveHour = report.windows.find((w) => w.key === 'five_hour');
		assert.equal(fiveHour?.utilization, 73);
	});

	it('a reader failure becomes text, never a throw', async () => {
		const failing = (async () => {
			throw new Error('no CLI here');
		}) as unknown as typeof readUsage;
		const fake = createFakeSupplyContext({ params: usageToolParams() });
		const supplied = await supplyClaudeCodeUsageTool(fake.supplyCtx, { readUsage: failing }, 0);
		const tool = supplied.response as { invoke: (v: unknown) => Promise<string> };
		const output = await tool.invoke({});
		assert.match(output, /Could not read Claude plan usage: no CLI here/);
	});

	it('a credential mode with nothing selected fails in supplyData, before the Agent runs', async () => {
		const fake = createFakeSupplyContext({
			params: usageToolParams({ authSource: 'apiKey' }),
		});
		await assert.rejects(
			supplyClaudeCodeUsageTool(fake.supplyCtx, { readUsage: fakeRead(WINDOWS) }, 0),
			/No credential selected/,
		);
	});
});
