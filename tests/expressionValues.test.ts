import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NodeOperationError } from 'n8n-workflow';
import { readParams } from '../nodes/ClaudeCode/params';
import { buildQueryOptions } from '../nodes/ClaudeCode/config';
import { readChatModelSettings } from '../nodes/ClaudeCodeChatModel/params';
import { readClaudeCodeToolSettings } from '../nodes/ClaudeCodeTool/params';
import { readUsageItems } from '../nodes/ClaudeCodeUsage/ClaudeCodeUsage.node';
import { supplyClaudeCodeUsageTool } from '../nodes/ClaudeCodeUsageTool/ClaudeCodeUsageTool.node';
import type { readUsage } from '../nodes/ClaudeCodeUsage/readUsage';
import { createPromptStream } from '../nodes/ClaudeCode/promptStream';
import { claudeCodeParams, createFakeContext } from './helpers/executeFunctions';
import { createFakeSupplyContext } from './helpers/supplyDataFunctions';

// n8n coerces a parameter only when it declares `validateType`, so an expression such as
// `{{ $json.ticketId }}` reaches the node as whatever it resolved to — here, a number.

const TICKET = 4711;

describe('Claude Code — text parameters set by an expression that resolves to a number', () => {
	const read = (over: Record<string, unknown>) =>
		readParams(createFakeContext({ typeVersion: 1.3, params: claudeCodeParams(over) }).ctx, 0);

	it('Session ID', () => {
		assert.equal(read({ sessionId: TICKET }).sessionId, '4711');
	});

	it('Prompt', () => {
		assert.equal(read({ prompt: TICKET }).prompt, '4711');
	});

	it('Project Path', () => {
		assert.equal(read({ projectPath: TICKET }).projectPath, '4711');
	});

	it('Binary Properties', () => {
		assert.deepEqual(read({ binaryProperties: TICKET }).attachments.names, ['4711']);
	});

	it('Path to Claude Code Executable', () => {
		const params = read({ additionalOptions: { pathToClaudeCodeExecutable: TICKET } });
		const outcome = buildQueryOptions(params, {
			abortController: new AbortController(),
			promptStream: createPromptStream('x'),
			onEffort: () => {},
		});
		assert.ok('config' in outcome);
		assert.equal(outcome.config.queryOptions.options.pathToClaudeCodeExecutable, '4711');
	});
});

describe('Chat Model — text parameters set by an expression that resolves to a number', () => {
	const settings = (over: Record<string, unknown>) =>
		readChatModelSettings(
			createFakeContext({
				params: { model: 'sonnet', projectPath: '', sessionId: '', options: {}, ...over },
			}).ctx,
			0,
		);

	it('Session ID resumes under the number as text', () => {
		const s = settings({ sessionId: TICKET });
		assert.equal(s.params.sessionId, '4711');
		assert.equal(s.params.operation, 'continue');
	});

	it('Process Name', () => {
		assert.equal(settings({ options: { processName: TICKET } }).processName, '4711');
	});

	it('Project Path', () => {
		assert.equal(settings({ projectPath: TICKET }).params.projectPath, '4711');
	});
});

describe('Task Tool — text parameters set by an expression that resolves to a number', () => {
	const settings = (over: Record<string, unknown>) =>
		readClaudeCodeToolSettings(
			createFakeContext({
				params: { model: 'sonnet', projectPath: '', toolDescription: 'x', options: {}, ...over },
			}).ctx,
			0,
		);

	it('Tool Description', () => {
		assert.equal(settings({ toolDescription: TICKET }).toolDescription, '4711');
	});

	it('Process Name', () => {
		assert.equal(settings({ options: { processName: TICKET } }).processName, '4711');
	});
});

describe('Usage — text parameters set by an expression that resolves to a number', () => {
	it('a numeric Project Path is validated as a path, not a crash', async () => {
		const { ctx } = createFakeContext({
			params: { operation: 'getUsage', projectPath: TICKET, timeout: 30, usageOptions: {} },
		});
		await assert.rejects(
			() => readUsageItems(ctx, { readUsage: (async () => ({})) as never }),
			(error: unknown) =>
				error instanceof NodeOperationError &&
				/Project Path is not an existing directory: 4711/.test(error.message),
		);
	});

	it('the Usage Tool takes a numeric Tool Description and Project Path', async () => {
		let cwd: unknown;
		const read = (async (options: { cwd?: string }) => {
			cwd = options.cwd;
			return {
				init: { apiKeySource: null, tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' },
				usage: { rate_limits: {} },
				claudeCodeVersion: '2.1.251',
				initMs: 5,
				usageMs: 7,
				unsupported: false,
				probeCostUsd: null,
			};
		}) as unknown as typeof readUsage;
		const fake = createFakeSupplyContext({
			params: { toolDescription: TICKET, authSource: 'host', projectPath: TICKET, options: {} },
		});
		const supplied = await supplyClaudeCodeUsageTool(fake.supplyCtx, { readUsage: read }, 0);
		const tool = supplied.response as {
			description: string;
			invoke: (v: unknown) => Promise<string>;
		};
		assert.equal(tool.description, '4711');
		await tool.invoke({});
		assert.equal(cwd, '4711');
	});
});
