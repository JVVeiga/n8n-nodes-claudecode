import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildQueryOptions, type ConfigDeps } from '../nodes/ClaudeCode/config';
import { readParams } from '../nodes/ClaudeCode/params';
import { createPromptStream } from '../nodes/ClaudeCode/promptStream';
import type { SdkOptions } from '../nodes/ClaudeCode/types';
import { claudeCodeParams, createFakeContext, type ParamMap } from './helpers/executeFunctions';

/** The stagedAttachments applier. The rest of the table is covered in config.test.ts. */
const deps = (over: Partial<ConfigDeps> = {}): ConfigDeps => ({
	abortController: new AbortController(),
	promptStream: createPromptStream('hello'),
	onEffort: () => {},
	pathExists: () => true,
	...over,
});

const build = (params: ParamMap = {}, over: Partial<ConfigDeps> = {}): SdkOptions => {
	const { ctx } = createFakeContext({ params: claudeCodeParams(params) });
	const outcome = buildQueryOptions(readParams(ctx, 0), deps(over));
	assert.ok('config' in outcome, 'expected a config, got a problem');
	return outcome.config.queryOptions.options;
};

const notesOf = (params: ParamMap = {}, over: Partial<ConfigDeps> = {}) => {
	const { ctx } = createFakeContext({ params: claudeCodeParams(params) });
	const outcome = buildQueryOptions(readParams(ctx, 0), deps(over));
	assert.ok('config' in outcome);
	return outcome.config.notes;
};

const STAGED = '/tmp/n8n-claude-deadbeef';

describe('stagedAttachments applier — no staging', () => {
	it('sets nothing when there is no staged directory', () => {
		const options = build();
		assert.equal(options.additionalDirectories, undefined);
	});

	it('leaves tools alone when there is no staged directory, even with a restriction', () => {
		const options = build({ restrictTools: ['Bash'] });
		assert.deepEqual(options.tools, ['Bash']);
	});
});

describe('stagedAttachments applier — with staging', () => {
	it('names exactly the staged directory', () => {
		assert.deepEqual(build({}, { stagedDir: STAGED }).additionalDirectories, [STAGED]);
	});

	it('records the directory in the notes, for the debug log', () => {
		assert.equal(notesOf({}, { stagedDir: STAGED }).stagedDir, STAGED);
	});

	it('leaves tools unset when there is no restriction — the full set already has Read', () => {
		const options = build({ restrictTools: [] }, { stagedDir: STAGED });
		assert.equal(options.tools, undefined);
	});

	it('adds Read to a restriction that omits it, so staging cannot fail silently', () => {
		const options = build({ restrictTools: ['Bash', 'Grep'] }, { stagedDir: STAGED });
		assert.deepEqual(options.tools, ['Bash', 'Grep', 'Read']);
		assert.equal(
			notesOf({ restrictTools: ['Bash'] }, { stagedDir: STAGED }).readAddedForStaging,
			true,
		);
	});

	it('leaves a restriction that already has Read untouched', () => {
		const options = build({ restrictTools: ['Read', 'Bash'] }, { stagedDir: STAGED });
		assert.deepEqual(options.tools, ['Read', 'Bash']);
		assert.equal(
			notesOf({ restrictTools: ['Read'] }, { stagedDir: STAGED }).readAddedForStaging,
			undefined,
		);
	});

	it('keeps the Ultracode orchestration tools when it adds Read', () => {
		// restrictTools runs first and adds Workflow/Task under Ultracode; reading params.restrictTools
		// instead of options.tools here would have dropped them.
		const options = build({ effort: 'ultracode', restrictTools: ['Bash'] }, { stagedDir: STAGED });
		assert.deepEqual(
			new Set(options.tools as string[]),
			new Set(['Bash', 'Workflow', 'Task', 'Read']),
		);
	});

	it('adds Read exactly once', () => {
		const options = build({ restrictTools: ['Bash'] }, { stagedDir: STAGED });
		assert.equal((options.tools as string[]).filter((t) => t === 'Read').length, 1);
	});
});
