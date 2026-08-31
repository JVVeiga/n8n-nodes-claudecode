import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildQueryOptions, type ConfigDeps } from '../nodes/ClaudeCode/config';
import { createPromptStream } from '../nodes/ClaudeCode/promptStream';
import type { ClaudeCodeParams, SdkOptions } from '../nodes/ClaudeCode/types';

/**
 * The three appliers the Chat Model node added to the shared table. They are driven by deps —
 * runtime facts, like stagedDir — so the main node's behaviour is untouched: with the deps
 * absent, none of them fires (pinned by the existing applier-order suite).
 */

const params = (over: Partial<ClaudeCodeParams> = {}): ClaudeCodeParams => ({
	operation: 'query',
	sessionId: '',
	prompt: 'hello',
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
	nodeVersion: 1.3,
	itemIndex: 0,
	...over,
});

const deps = (over: Partial<ConfigDeps> = {}): ConfigDeps => ({
	abortController: new AbortController(),
	promptStream: createPromptStream('hello'),
	onEffort: () => {},
	pathExists: () => true,
	processEnv: { PATH: '/usr/bin' },
	...over,
});

const MCP: NonNullable<ConfigDeps['mcp']> = {
	servers: { n8n: { type: 'sdk', name: 'n8n', instance: {} as never } },
	toolNames: ['mcp__n8n__calculator'],
};

const optionsOf = (p: ClaudeCodeParams, d: ConfigDeps): SdkOptions => {
	const outcome = buildQueryOptions(p, d);
	assert.ok('config' in outcome, 'expected a config, not a problem');
	return outcome.config.queryOptions.options;
};

describe('the mcpServers applier', () => {
	it('sets the server and pre-approves the bridged tool names', () => {
		const options = optionsOf(params(), deps({ mcp: MCP }));
		assert.deepEqual(Object.keys(options.mcpServers ?? {}), ['n8n']);
		assert.deepEqual(options.allowedTools, ['mcp__n8n__calculator']);
	});

	it('appends the bridged names to an active restriction, so it cannot unplug them', () => {
		const options = optionsOf(params({ restrictTools: ['Bash'] }), deps({ mcp: MCP }));
		assert.deepEqual(options.tools, ['Bash', 'mcp__n8n__calculator']);
	});

	it('leaves an empty (= full) tool set alone — only a real restriction is amended', () => {
		const options = optionsOf(params(), deps({ mcp: MCP }));
		assert.equal(options.tools, undefined);
	});

	it('merges with pre-approvals the user already made', () => {
		const options = optionsOf(params({ allowedTools: ['WebSearch'] }), deps({ mcp: MCP }));
		assert.deepEqual(options.allowedTools, ['WebSearch', 'mcp__n8n__calculator']);
	});
});

describe('the systemPromptReplace applier', () => {
	it('replaces the preset outright — and wins over an append that is somehow also set', () => {
		const options = optionsOf(
			params({ additional: { systemPrompt: 'appended', wrapUpGraceSeconds: 60 } }),
			deps({ systemPromptReplace: 'you are a poet' }),
		);
		assert.equal(options.systemPrompt, 'you are a poet');
	});

	it('empty string is a valid replacement: it means "no system prompt", not "do nothing"', () => {
		const options = optionsOf(params(), deps({ systemPromptReplace: '' }));
		assert.equal(options.systemPrompt, '');
	});
});

describe('the newSessionId applier', () => {
	it('sets the SDK sessionId only when a deterministic id is handed in', () => {
		assert.equal(optionsOf(params(), deps()).sessionId, undefined);
		assert.equal(
			optionsOf(params(), deps({ newSessionId: '00000000-0000-5000-8000-000000000001' })).sessionId,
			'00000000-0000-5000-8000-000000000001',
		);
	});
});

describe('the partialMessages applier', () => {
	it('turns on stream events only when asked', () => {
		assert.equal(optionsOf(params(), deps()).includePartialMessages, undefined);
		assert.equal(
			optionsOf(params(), deps({ includePartialMessages: true })).includePartialMessages,
			true,
		);
	});
});
