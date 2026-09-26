import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	parseInstructionFiles,
	readAgentParams,
	resolveAgentAttachAll,
} from '../nodes/ClaudeCodeAgent/params';
import { readConnections } from '../nodes/ClaudeCodeAgent/connections';
import { DEFAULT_VERIFIER_INSTRUCTIONS } from '../nodes/ClaudeCodeAgent/verification/prompt';
import { createFakeContext } from './helpers/executeFunctions';

const agentParams = (over: Record<string, unknown> = {}) => ({
	prompt: 'Summarise the repository.',
	model: 'sonnet',
	projectPath: '/repo',
	effort: 'high',
	maxTurns: 25,
	timeout: 300,
	options: {},
	...over,
});

const read = (over: Record<string, unknown> = {}) =>
	readAgentParams(createFakeContext({ typeVersion: 1, params: agentParams(over) }).ctx, 0);

describe('readAgentParams — the run parameters', () => {
	it('fills ClaudeCodeParams as a single new query in text format', () => {
		const { run } = read({ effort: 'ultracode', maxTurns: 40, timeout: 900 });
		assert.equal(run.operation, 'query');
		assert.equal(run.sessionId, '');
		assert.equal(run.outputFormat, 'text');
		assert.equal(run.nodeVersion, 1);
		assert.equal(run.prompt, 'Summarise the repository.');
		assert.equal(run.model, 'sonnet');
		assert.equal(run.projectPath, '/repo');
		assert.equal(run.effort, 'ultracode');
		assert.equal(run.maxTurns, 40);
		assert.equal(run.timeoutSeconds, 900);
	});

	it('takes the sub-nodes’ defaults for unset options', () => {
		const { run } = read();
		assert.equal(run.additional.wrapUpGraceSeconds, 60);
		assert.equal(run.additional.permissionMode, 'bypassPermissions');
		assert.equal(run.additional.debug, false);
		assert.deepEqual(run.allowedTools, []);
		assert.deepEqual(run.restrictTools, []);
		assert.equal(run.attachments.inlineTextLimitKb, 256);
		assert.equal(run.attachments.maxAttachmentMb, 50);
		assert.equal(run.attachments.maxAttachmentCount, 16);
		assert.deepEqual(run.attachments.allowedExtensions, []);
	});

	it('reads every run option from the collection', () => {
		const { run } = read({
			options: {
				permissionMode: 'dontAsk',
				systemPrompt: 'Be terse.',
				fallbackModel: 'haiku',
				thinking: 'adaptive',
				maxThinkingTokens: 2000,
				maxBudgetUsd: 1.5,
				wrapUpGraceSeconds: 30,
				allowedTools: ['Read'],
				disallowedTools: ['Bash'],
				restrictTools: ['Read', 'Grep'],
				pathToClaudeCodeExecutable: '/usr/local/bin/claude',
				debug: true,
			},
		});
		assert.equal(run.additional.permissionMode, 'dontAsk');
		assert.equal(run.additional.systemPrompt, 'Be terse.');
		assert.equal(run.additional.fallbackModel, 'haiku');
		assert.equal(run.additional.thinking, 'adaptive');
		assert.equal(run.additional.maxThinkingTokens, 2000);
		assert.equal(run.additional.maxBudgetUsd, 1.5);
		assert.equal(run.additional.wrapUpGraceSeconds, 30);
		assert.equal(run.additional.pathToClaudeCodeExecutable, '/usr/local/bin/claude');
		assert.equal(run.additional.debug, true);
		assert.deepEqual(run.allowedTools, ['Read']);
		assert.deepEqual(run.disallowedTools, ['Bash']);
		assert.deepEqual(run.restrictTools, ['Read', 'Grep']);
	});
});

describe('readAgentParams — attachments', () => {
	it('Attach All Binaries on Auto means on for the Agent', () => {
		assert.equal(read().run.attachments.all, true);
		assert.equal(read({ attachAllBinaries: 'auto' }).run.attachments.all, true);
		assert.equal(resolveAgentAttachAll('on'), true);
		assert.equal(resolveAgentAttachAll('off'), false);
	});

	it('Off with named properties sends only those', () => {
		const { run } = read({ attachAllBinaries: 'off', binaryProperties: 'data, screenshot' });
		assert.equal(run.attachments.all, false);
		assert.deepEqual(run.attachments.names, ['data', 'screenshot']);
	});
});

describe('readAgentParams — the Agent’s own settings', () => {
	it('defaults: text, no files, new session, auto orchestration, connectors off, no transcript', () => {
		const { agent } = read();
		assert.deepEqual(agent, {
			outputMode: 'text',
			jsonSchemaText: '',
			instructionFiles: [],
			session: { mode: 'new', key: '' },
			orchestration: 'auto',
			allowConnectors: false,
			includeTranscript: false,
			usageWorkflowId: '',
			processName: '',
			verification: null,
		});
	});

	it('reads each setting', () => {
		const { agent } = read({
			outputMode: 'jsonSchema',
			jsonSchema: '{"type":"object"}',
			instructionFiles: '.review/rules.md\n\n  docs/conventions.md  \r\n',
			sessionMode: 'resume',
			sessionKey: '  ticket-42 ',
			subagentOrchestration: 'required',
			options: {
				allowClaudeAiConnectors: true,
				includeTranscript: true,
				reportUsageTo: { __rl: true, value: 'wf-collector', mode: 'list' },
				processName: ' review-bot ',
			},
		});
		assert.equal(agent.outputMode, 'jsonSchema');
		assert.equal(agent.jsonSchemaText, '{"type":"object"}');
		assert.deepEqual(agent.instructionFiles, ['.review/rules.md', 'docs/conventions.md']);
		assert.deepEqual(agent.session, { mode: 'resume', key: 'ticket-42' });
		assert.equal(agent.orchestration, 'required');
		assert.equal(agent.allowConnectors, true);
		assert.equal(agent.includeTranscript, true);
		assert.equal(agent.usageWorkflowId, 'wf-collector');
		assert.equal(agent.processName, 'review-bot');
	});

	it('a JSON Schema that arrives already parsed is turned back into text', () => {
		const { agent } = read({ outputMode: 'jsonSchema', jsonSchema: { type: 'object' } });
		assert.equal(agent.jsonSchemaText, '{"type":"object"}');
	});

	it('Verification is null unless enabled', () => {
		assert.equal(read().agent.verification, null);
		assert.equal(read({ verification: { itemsPath: 'findings' } }).agent.verification, null);
		assert.equal(
			read({ verification: { enabled: false, itemsPath: 'findings' } }).agent.verification,
			null,
		);
	});

	it('reads Verification: trimmed path, comma-separated filter values, default instructions', () => {
		const { agent } = read({
			verification: {
				enabled: true,
				itemsPath: ' review.inline_comments ',
				filterField: ' severity ',
				filterValues: 'high, critical ,, ',
			},
		});
		assert.deepEqual(agent.verification, {
			itemsPath: 'review.inline_comments',
			filter: { field: 'severity', values: ['high', 'critical'] },
			instructions: DEFAULT_VERIFIER_INSTRUCTIONS,
		});
	});

	it('Verification with no filter field has no filter; blank instructions fall back', () => {
		const { agent } = read({
			verification: {
				enabled: true,
				itemsPath: 'findings',
				filterValues: 'high',
				instructions: '   ',
			},
		});
		assert.equal(agent.verification?.filter, null);
		assert.equal(agent.verification?.instructions, DEFAULT_VERIFIER_INSTRUCTIONS);
		const custom = read({
			verification: { enabled: true, itemsPath: 'findings', instructions: ' Be strict. ' },
		});
		assert.equal(custom.agent.verification?.instructions, 'Be strict.');
	});

	it('expression values of another type are coerced, not crashed on', () => {
		const { run, agent } = read({
			prompt: 42,
			projectPath: 7,
			sessionMode: 'resume',
			sessionKey: 12345,
			instructionFiles: [' a.md ', '', 'b.md', 3],
			options: { processName: 99 },
			verification: {
				enabled: true,
				itemsPath: 5,
				filterField: 0,
				filterValues: [' high ', 'critical', '', 1],
				instructions: 8,
			},
		});
		assert.equal(run.prompt, '42');
		assert.equal(run.projectPath, '7');
		assert.equal(agent.session.key, '12345');
		assert.deepEqual(agent.instructionFiles, ['a.md', 'b.md', '3']);
		assert.equal(agent.processName, '99');
		assert.deepEqual(agent.verification, {
			itemsPath: '5',
			filter: { field: '0', values: ['high', 'critical', '1'] },
			instructions: '8',
		});
	});

	it('null from an expression reads as empty', () => {
		const { run, agent } = read({
			prompt: null,
			sessionKey: null,
			instructionFiles: null,
			verification: { enabled: true, itemsPath: null, filterField: null, filterValues: null },
		});
		assert.equal(run.prompt, '');
		assert.equal(agent.session.key, '');
		assert.deepEqual(agent.instructionFiles, []);
		assert.equal(agent.verification?.itemsPath, '');
		assert.equal(agent.verification?.filter, null);
	});

	it('parseInstructionFiles drops blank lines and surrounding space', () => {
		assert.deepEqual(parseInstructionFiles(''), []);
		assert.deepEqual(parseInstructionFiles(' a.md \n\nb/c.md'), ['a.md', 'b/c.md']);
	});
});

describe('readConnections', () => {
	it('flattens tools and toolkits, passing subagents and the parser through', async () => {
		const tool = { name: 'lookup', invoke: async () => 'ok' };
		const kitTool = { name: 'kit_a', invoke: async () => 'ok' };
		const toolkit = { tools: [kitTool], getTools: () => [kitTool] };
		const subagent = { name: 'reviewer' };
		const parser = { getSchema: () => ({}) };
		const fake = createFakeContext({
			connections: { ai_tool: [tool, toolkit], ai_agent: [subagent], ai_outputParser: parser },
		});
		const connections = await readConnections(fake.ctx, 0);
		assert.deepEqual(
			connections.tools.map((t) => t.name),
			['lookup', 'kit_a'],
		);
		assert.deepEqual(connections.subagents, [subagent]);
		assert.equal(connections.parser, parser);
		assert.deepEqual(
			fake.connectionReads.map((r) => r.type),
			['ai_tool', 'ai_agent', 'ai_outputParser'],
		);
	});

	it('nothing connected: no tools, and undefined for the rest', async () => {
		const fake = createFakeContext({
			connections: { ai_tool: undefined, ai_agent: undefined, ai_outputParser: undefined },
		});
		const connections = await readConnections(fake.ctx, 0);
		assert.deepEqual(connections.tools, []);
		assert.equal(connections.subagents, undefined);
		assert.equal(connections.parser, undefined);
	});

	it('a parser delivered inside an array is unwrapped', async () => {
		const parser = { getSchema: () => ({}) };
		const fake = createFakeContext({
			connections: { ai_tool: [], ai_agent: [], ai_outputParser: [parser] },
		});
		assert.equal((await readConnections(fake.ctx, 0)).parser, parser);
	});
});
