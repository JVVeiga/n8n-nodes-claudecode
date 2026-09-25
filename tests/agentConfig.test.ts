import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildQueryOptions, type ConfigDeps } from '../nodes/ClaudeCode/config';
import { readParams } from '../nodes/ClaudeCode/params';
import { createPromptStream } from '../nodes/ClaudeCode/promptStream';
import type { SdkOptions } from '../nodes/ClaudeCode/types';
import { claudeCodeParams, createFakeContext } from './helpers/executeFunctions';

const controller = new AbortController();
const promptStream = createPromptStream('hello');

const deps = (over: Partial<ConfigDeps> = {}): ConfigDeps => ({
	abortController: controller,
	promptStream,
	onEffort: () => {},
	pathExists: () => true,
	...over,
});

const outcomeOf = (over: Record<string, unknown>, d: ConfigDeps) => {
	const { ctx } = createFakeContext({ typeVersion: 1.3, params: claudeCodeParams(over) });
	const outcome = buildQueryOptions(readParams(ctx, 0), d);
	assert.ok('config' in outcome, 'expected a config, got a problem');
	return outcome.config;
};

const build = (over: Record<string, unknown> = {}, d = deps()): SdkOptions =>
	outcomeOf(over, d).queryOptions.options;

/** The hooks are fresh closures on every build, so compare their shape rather than identity. */
const comparable = (options: SdkOptions) => ({
	...options,
	hooks: Object.keys(options.hooks ?? {}),
});

const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } } };

describe('agent appliers — no-ops when their input is absent', () => {
	it('none of them fires on a plain config', () => {
		const config = outcomeOf({}, deps());
		for (const name of ['agents', 'outputFormat', 'claudeAiConnectors']) {
			assert.ok(!config.applied.includes(name), `${name} should not fire`);
		}
		const options = config.queryOptions.options;
		assert.equal('agents' in options, false);
		assert.equal('outputFormat' in options, false);
		assert.equal('settings' in options, false);
	});

	it('an empty agents map sets nothing', () => {
		const config = outcomeOf({}, deps({ agents: {} }));
		assert.ok(!config.applied.includes('agents'));
		assert.equal('agents' in config.queryOptions.options, false);
	});

	it('claudeAiConnectors true leaves the CLI default', () => {
		const config = outcomeOf({}, deps({ claudeAiConnectors: true }));
		assert.ok(!config.applied.includes('claudeAiConnectors'));
		assert.equal('settings' in config.queryOptions.options, false);
	});

	it('an empty instructionsAppend with no System Prompt sets no system prompt', () => {
		const config = outcomeOf({}, deps({ instructionsAppend: '' }));
		assert.ok(!config.applied.includes('systemPrompt'));
		assert.equal('systemPrompt' in config.queryOptions.options, false);
	});
});

describe('agent appliers — when given', () => {
	it('agents are passed through', () => {
		const agents = {
			reviewer: { description: 'Reviews code', prompt: 'You review code.' },
		};
		assert.equal(build({}, deps({ agents })).agents, agents);
	});

	it('outputFormat is passed through', () => {
		const outputFormat = { type: 'json_schema' as const, schema: SCHEMA };
		assert.deepEqual(build({}, deps({ outputFormat })).outputFormat, outputFormat);
	});

	it('claudeAiConnectors false disables them', () => {
		assert.deepEqual(build({}, deps({ claudeAiConnectors: false })).settings, {
			disableClaudeAiConnectors: true,
		});
	});

	it('disabling connectors keeps the ultracode setting', () => {
		const options = build({ effort: 'ultracode' }, deps({ claudeAiConnectors: false }));
		assert.deepEqual(options.settings, { ultracode: true, disableClaudeAiConnectors: true });
	});
});

describe('systemPrompt — instructions appended after System Prompt', () => {
	it('joins System Prompt and instructions with a blank line', () => {
		const options = build(
			{ additionalOptions: { systemPrompt: 'Be terse.' } },
			deps({ instructionsAppend: '<instructions>x</instructions>' }),
		);
		assert.deepEqual(options.systemPrompt, {
			type: 'preset',
			preset: 'claude_code',
			append: 'Be terse.\n\n<instructions>x</instructions>',
		});
	});

	it('instructions alone fill the append slot', () => {
		const options = build({}, deps({ instructionsAppend: 'Follow the repo rules.' }));
		assert.deepEqual(options.systemPrompt, {
			type: 'preset',
			preset: 'claude_code',
			append: 'Follow the repo rules.',
		});
	});

	it('System Prompt alone is unchanged', () => {
		const options = build({ additionalOptions: { systemPrompt: 'Be terse.' } });
		assert.deepEqual(options.systemPrompt, {
			type: 'preset',
			preset: 'claude_code',
			append: 'Be terse.',
		});
	});
});

describe('existing inputs produce identical options', () => {
	const cases: Array<Record<string, unknown>> = [
		{},
		{ additionalOptions: { systemPrompt: 'Be terse.' } },
		{ effort: 'ultracode', restrictTools: ['Read', 'Bash'] },
		{ allowedTools: ['Read'], disallowedTools: ['Bash'] },
		{ operation: 'continue', sessionId: 'abc' },
		{ additionalOptions: { maxBudgetUsd: 1, thinking: 'adaptive' } },
	];
	for (const over of cases) {
		it(`absent-valued agent inputs change nothing for ${JSON.stringify(over)}`, () => {
			const before = build(over);
			const after = build(
				over,
				deps({
					agents: {},
					outputFormat: undefined,
					claudeAiConnectors: true,
					instructionsAppend: '',
				}),
			);
			assert.deepEqual(comparable(after), comparable(before));
		});
	}
});
