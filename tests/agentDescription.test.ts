import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { INodeProperties } from 'n8n-workflow';
import {
	AGENT_ATTACH_ALL_PROPERTY,
	claudeCodeAgentDescription,
} from '../nodes/ClaudeCodeAgent/description';
import { DEFAULT_VERIFIER_INSTRUCTIONS } from '../nodes/ClaudeCodeAgent/verification/prompt';
import { PERMISSION_MODE_OPTION } from '../nodes/ClaudeCode/description/additionalOptions';
import {
	ATTACH_ALL_BINARIES_PROPERTY,
	BINARY_PROPERTIES_PROPERTY,
} from '../nodes/ClaudeCode/description/properties';
import {
	AUTHENTICATION_CREDENTIALS,
	AUTHENTICATION_PROPERTY,
} from '../nodes/shared/authDescription';
import {
	allowedToolsOption,
	debugOption,
	executablePathOption,
	fallbackModelOption,
	maxThinkingTokensOption,
	modelProperty,
	processNameOption,
	reportUsageToOption,
	thinkingOption,
	wrapUpGraceOption,
} from '../nodes/shared/runOptions';

const d = claudeCodeAgentDescription;
const property = (name: string) => d.properties.find((p) => p.name === name);
const options = (): INodeProperties[] => (property('options')?.options ?? []) as INodeProperties[];
const option = (name: string) => options().find((o) => o.name === name);

describe('Claude Code Agent — identity and connections', () => {
	it('is a version-1 main node named claudeCodeAgent, not usable as a tool', () => {
		assert.equal(d.name, 'claudeCodeAgent');
		assert.equal(d.displayName, 'Claude Code Agent');
		assert.equal(d.version, 1);
		assert.equal(d.icon, 'file:claudecode.svg');
		assert.equal(d.defaults.name, 'Claude Code Agent');
		assert.equal((d as { usableAsTool?: boolean }).usableAsTool, undefined);
	});

	it('inputs: main, subagents, tools and at most one output parser', () => {
		assert.deepEqual(d.inputs, [
			'main',
			{ type: 'ai_agent', displayName: 'Subagents', required: false },
			{ type: 'ai_tool', displayName: 'Tools', required: false },
			{ type: 'ai_outputParser', displayName: 'Parser', maxConnections: 1, required: false },
		]);
		assert.deepEqual(d.outputs, ['main']);
	});

	it('uses the shared authentication selector, named authSource', () => {
		assert.equal(d.credentials, AUTHENTICATION_CREDENTIALS);
		assert.equal(property('authSource'), AUTHENTICATION_PROPERTY);
		assert.equal(property('authentication'), undefined);
	});
});

describe('Claude Code Agent — parameters', () => {
	it('declares the top-level parameters', () => {
		assert.deepEqual(
			d.properties.map((p) => p.name),
			[
				'authSource',
				'prompt',
				'projectPath',
				'model',
				'effort',
				'maxTurns',
				'timeout',
				'attachAllBinaries',
				'binaryProperties',
				'outputMode',
				'jsonSchema',
				'instructionFiles',
				'sessionMode',
				'sessionKey',
				'subagentOrchestration',
				'verification',
				'options',
			],
		);
		assert.equal(property('prompt')?.required, true);
	});

	it('reuses the Claude Code node’s property objects rather than copies', () => {
		assert.equal(property('attachAllBinaries'), AGENT_ATTACH_ALL_PROPERTY);
		assert.equal(AGENT_ATTACH_ALL_PROPERTY.name, ATTACH_ALL_BINARIES_PROPERTY.name);
		assert.equal(AGENT_ATTACH_ALL_PROPERTY.default, 'on');
		assert.deepEqual(
			(AGENT_ATTACH_ALL_PROPERTY.options as Array<{ value: string }>).map((o) => o.value),
			['off', 'on'],
		);
		assert.equal(property('binaryProperties'), BINARY_PROPERTIES_PROPERTY);
		assert.deepEqual(property('model'), modelProperty());
		assert.equal(option('permissionMode'), PERMISSION_MODE_OPTION);
	});

	it('Effort offers Ultracode, as on the other nodes', () => {
		const values = (property('effort')?.options ?? []).map((o) => (o as { value: string }).value);
		assert.ok(values.includes('ultracode'));
		assert.equal(property('effort')?.default, 'high');
	});

	it('Output Mode, Session and Orchestration default to the plain behaviour', () => {
		assert.equal(property('outputMode')?.default, 'text');
		assert.equal(property('sessionMode')?.default, 'new');
		assert.equal(property('subagentOrchestration')?.default, 'auto');
	});

	it('JSON Schema shows only in its mode and defaults to a usable object schema', () => {
		assert.deepEqual(property('jsonSchema')?.displayOptions, {
			show: { outputMode: ['jsonSchema'] },
		});
		const schema = JSON.parse(property('jsonSchema')?.default as string);
		assert.equal(schema.type, 'object');
	});

	it('Session ID or Key shows only in resume mode', () => {
		assert.deepEqual(property('sessionKey')?.displayOptions, { show: { sessionMode: ['resume'] } });
	});
});

describe('Claude Code Agent — options compose the shared factories', () => {
	it('declares exactly the options the params reader consumes', () => {
		assert.deepEqual(
			options()
				.map((o) => o.name)
				.sort(),
			[
				'allowClaudeAiConnectors',
				'allowedTools',
				'debug',
				'disallowedTools',
				'fallbackModel',
				'includeTranscript',
				'maxBudgetUsd',
				'maxThinkingTokens',
				'pathToClaudeCodeExecutable',
				'permissionMode',
				'processName',
				'reportUsageTo',
				'restrictTools',
				'systemPrompt',
				'thinking',
				'wrapUpGraceSeconds',
			],
		);
	});

	it('the factory-built options are identical to the factories’ output', () => {
		for (const expected of [
			allowedToolsOption(),
			debugOption(),
			executablePathOption(),
			fallbackModelOption(),
			maxThinkingTokensOption(),
			processNameOption(),
			reportUsageToOption(),
			thinkingOption(),
			wrapUpGraceOption(),
		]) {
			assert.deepEqual(option(expected.name), expected, expected.name);
		}
	});

	it('the options that take per-node wording keep the factories’ shape', () => {
		for (const name of ['disallowedTools', 'restrictTools', 'maxBudgetUsd', 'systemPrompt']) {
			const declared = option(name) as INodeProperties;
			assert.ok(declared, name);
			assert.equal(typeof declared.description, 'string', name);
		}
	});

	it('Include Transcript and claude.ai connectors are off by default', () => {
		assert.equal(option('includeTranscript')?.default, false);
		assert.equal(option('allowClaudeAiConnectors')?.default, false);
	});
});

describe('Claude Code Agent — Verification', () => {
	const verification = () => property('verification') as INodeProperties;
	const field = (name: string) =>
		(verification().options as INodeProperties[]).find((o) => o.name === name);

	it('is a collection with exactly the fields readVerification consumes', () => {
		assert.equal(verification().type, 'collection');
		assert.deepEqual(verification().default, {});
		assert.deepEqual(
			(verification().options as INodeProperties[]).map((o) => o.name),
			['enabled', 'filterValues', 'itemsPath', 'filterField', 'instructions'],
		);
	});

	it('is off by default, hidden for Text, and prefilled with the default instructions', () => {
		assert.equal(field('enabled')?.default, false);
		assert.deepEqual(verification().displayOptions, { hide: { outputMode: ['text'] } });
		assert.equal(field('instructions')?.default, DEFAULT_VERIFIER_INSTRUCTIONS);
	});

	it('says it needs structured output and runs a resumed second turn', () => {
		assert.match(verification().description ?? '', /JSON Schema or Output Parser/);
		assert.match(field('enabled')?.description ?? '', /resumes the session/);
	});
});

describe('Claude Code Agent — one reader per n8n seam', () => {
	const dir = join(process.cwd(), 'nodes', 'ClaudeCodeAgent');
	const sources = (readdirSync(dir, { recursive: true }) as string[])
		.filter((f) => f.endsWith('.ts'))
		.map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));

	it('only params.ts calls getNodeParameter', () => {
		const readers = sources.filter((s) => /\.getNodeParameter\(/.test(s.text)).map((s) => s.file);
		assert.deepEqual(readers, ['params.ts']);
	});

	it('only connections.ts calls getInputConnectionData', () => {
		const readers = sources
			.filter((s) => /\.getInputConnectionData\(/.test(s.text))
			.map((s) => s.file);
		assert.deepEqual(readers, ['connections.ts']);
	});
});
