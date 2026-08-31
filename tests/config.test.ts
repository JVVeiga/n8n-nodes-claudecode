import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APPLIER_NAMES, buildQueryOptions, type ConfigDeps } from '../nodes/ClaudeCode/config';
import { readParams } from '../nodes/ClaudeCode/params';
import { createPromptStream } from '../nodes/ClaudeCode/promptStream';
import type { SdkOptions } from '../nodes/ClaudeCode/types';
import { claudeCodeParams, createFakeContext } from './helpers/executeFunctions';

const deps = (over: Partial<ConfigDeps> = {}): ConfigDeps => ({
	abortController: new AbortController(),
	promptStream: createPromptStream('hello'),
	onEffort: () => {},
	// Every path exists unless a test says otherwise — no filesystem is touched.
	pathExists: () => true,
	...over,
});

/** Build options, asserting success. */
const build = (over: Record<string, unknown> = {}, typeVersion = 1.1, d = deps()): SdkOptions => {
	const { ctx } = createFakeContext({ typeVersion, params: claudeCodeParams(over) });
	const outcome = buildQueryOptions(readParams(ctx, 0), d);
	assert.ok('config' in outcome, 'expected a config, got a problem');
	return outcome.config.queryOptions.options;
};

/** Build, asserting failure, and return the problem. */
const problemOf = (over: Record<string, unknown> = {}, d = deps()) => {
	const { ctx } = createFakeContext({ params: claudeCodeParams(over) });
	const outcome = buildQueryOptions(readParams(ctx, 0), d);
	assert.ok('problem' in outcome, 'expected a problem, got a config');
	return outcome.problem;
};

const applied = (over: Record<string, unknown> = {}, d = deps()): string[] => {
	const { ctx } = createFakeContext({ params: claudeCodeParams(over) });
	const outcome = buildQueryOptions(readParams(ctx, 0), d);
	assert.ok('config' in outcome);
	return outcome.config.applied;
};

describe('buildQueryOptions — the base options', () => {
	it('always sets the abort controller, turns, model and effort', () => {
		const controller = new AbortController();
		const options = build({}, 1.1, deps({ abortController: controller }));
		assert.equal(options.abortController, controller);
		assert.equal(options.maxTurns, 5);
		assert.equal(options.model, 'claude-sonnet-5');
		assert.equal(options.effort, 'high');
	});

	it('defaults permissionMode to bypassPermissions — n8n runs headless and cannot answer a prompt', () => {
		assert.equal(build().permissionMode, 'bypassPermissions');
	});

	it('honours an explicit permission mode', () => {
		assert.equal(
			build({ additionalOptions: { permissionMode: 'dontAsk' } }).permissionMode,
			'dontAsk',
		);
	});

	it('passes the prompt stream through, not a string — interrupt() needs streaming input mode', () => {
		const stream = createPromptStream('hi');
		const { ctx } = createFakeContext({ params: claudeCodeParams() });
		const outcome = buildQueryOptions(readParams(ctx, 0), deps({ promptStream: stream }));
		assert.ok('config' in outcome);
		assert.equal(outcome.config.queryOptions.prompt, stream.stream);
	});

	it('sets nothing it was not asked for', () => {
		const options = build();
		for (const key of [
			'cwd',
			'tools',
			'allowedTools',
			'disallowedTools',
			'fallbackModel',
			'thinking',
			'maxThinkingTokens',
			'maxBudgetUsd',
			'resume',
			'continue',
			'settings',
			'systemPrompt',
			'canUseTool',
			'pathToClaudeCodeExecutable',
		]) {
			assert.equal((options as Record<string, unknown>)[key], undefined, `${key} should be unset`);
		}
	});
});

describe('buildQueryOptions — plan mode', () => {
	it('registers no permission callback on its own', () => {
		assert.equal(build({ additionalOptions: { permissionMode: 'plan' } }).canUseTool, undefined);
	});

	it('registers one when plan execution is allowed — without it, plan mode can never act', () => {
		const options = build({
			additionalOptions: { permissionMode: 'plan', allowPlanExecution: true },
		});
		assert.equal(typeof options.canUseTool, 'function');
	});

	it('the callback allows the tool with its input unchanged', async () => {
		const options = build({
			additionalOptions: { permissionMode: 'plan', allowPlanExecution: true },
		});
		const decision = await options.canUseTool!('Bash', { command: 'ls' }, {} as never);
		assert.deepEqual(decision, { behavior: 'allow', updatedInput: { command: 'ls' } });
	});

	it('does nothing outside plan mode, even when allowPlanExecution is on', () => {
		assert.equal(build({ additionalOptions: { allowPlanExecution: true } }).canUseTool, undefined);
	});
});

describe('buildQueryOptions — Ultracode', () => {
	it('sets the session setting and translates the effort', () => {
		const options = build({ effort: 'ultracode' });
		assert.deepEqual(options.settings, { ultracode: true });
		assert.equal(options.effort, 'xhigh', 'the SDK has no "ultracode" effort level');
	});

	it('adds Workflow and Task to a tool restriction rather than letting it disable orchestration', () => {
		const options = build({ effort: 'ultracode', restrictTools: ['Read', 'Bash'] });
		assert.deepEqual(options.tools, ['Read', 'Bash', 'Workflow', 'Task']);
	});

	it('adds them to the auto-approve list too, so orchestration is not gated by a prompt', () => {
		const options = build({ effort: 'ultracode', allowedTools: ['Read'] });
		assert.deepEqual(options.allowedTools, ['Read', 'Workflow', 'Task']);
	});

	it('does NOT invent a restriction when none was asked for — an empty selection means the full set', () => {
		const options = build({ effort: 'ultracode' });
		assert.equal(options.tools, undefined, 'adding Workflow+Task here would restrict to two tools');
		assert.equal(options.allowedTools, undefined);
	});

	it('does not duplicate Workflow or Task when they were already selected', () => {
		const options = build({ effort: 'ultracode', restrictTools: ['Workflow', 'Read'] });
		assert.deepEqual(options.tools, ['Workflow', 'Read', 'Task']);
	});

	it('leaves the tool lists alone when Ultracode is off', () => {
		assert.deepEqual(build({ restrictTools: ['Read'] }).tools, ['Read']);
		assert.deepEqual(build({ allowedTools: ['Read'] }).allowedTools, ['Read']);
	});
});

describe('buildQueryOptions — the effort-capture hooks', () => {
	it('registers the same capture on all four hook points', () => {
		// Stop and SubagentStop matter: they fire at end of turn, so a plain reply with no tool use
		// is covered too. PreToolUse alone would miss it.
		const hooks = build().hooks as Record<string, unknown>;
		assert.deepEqual(Object.keys(hooks).sort(), [
			'PostToolUse',
			'PreToolUse',
			'Stop',
			'SubagentStop',
		]);
	});

	it('reports the effort level the hook receives', async () => {
		const seen: string[] = [];
		const options = build({}, 1.1, deps({ onEffort: (level) => seen.push(level) }));
		const hooks = options.hooks as {
			Stop: Array<{ hooks: Array<(i: unknown) => Promise<unknown>> }>;
		};
		const result = await hooks.Stop[0].hooks[0]({ effort: { level: 'medium' } });
		assert.deepEqual(seen, ['medium']);
		assert.deepEqual(result, { continue: true });
	});

	it('ignores a hook payload with no effort level, and never blocks the run', async () => {
		const seen: string[] = [];
		const options = build({}, 1.1, deps({ onEffort: (level) => seen.push(level) }));
		const hooks = options.hooks as {
			Stop: Array<{ hooks: Array<(i: unknown) => Promise<unknown>> }>;
		};
		assert.deepEqual(await hooks.Stop[0].hooks[0]({}), { continue: true });
		assert.deepEqual(await hooks.Stop[0].hooks[0](undefined), { continue: true });
		assert.deepEqual(seen, []);
	});
});

describe('buildQueryOptions — system prompt', () => {
	it('appends to the claude_code preset rather than replacing it', () => {
		const options = build({ additionalOptions: { systemPrompt: 'be terse' } });
		assert.deepEqual(options.systemPrompt, {
			type: 'preset',
			preset: 'claude_code',
			append: 'be terse',
		});
	});

	it('is unset when empty, so the preset stands alone', () => {
		assert.equal(build({ additionalOptions: { systemPrompt: '' } }).systemPrompt, undefined);
	});
});

describe('buildQueryOptions — project path', () => {
	it('sets cwd for a directory that exists', () => {
		assert.equal(build({ projectPath: '/workspace' }).cwd, '/workspace');
	});

	it('trims before setting', () => {
		assert.equal(build({ projectPath: '  /workspace  ' }).cwd, '/workspace');
	});

	it('leaves cwd unset for an empty path', () => {
		assert.equal(build({ projectPath: '' }).cwd, undefined);
	});

	it('refuses a path that does not exist, naming the n8n field', () => {
		const problem = problemOf({ projectPath: '/nope' }, deps({ pathExists: () => false }));
		assert.equal(problem.message, 'Project Path is not an existing directory: /nope');
		assert.match(problem.description ?? '', /Docker/);
	});

	it('does not consult the filesystem for an empty path', () => {
		let checked = 0;
		build({ projectPath: '' }, 1.1, deps({ pathExists: () => (checked++, true) }));
		assert.equal(checked, 0);
	});
});

describe('buildQueryOptions — fallback model', () => {
	it('sets it when different from the primary', () => {
		const options = build({
			model: 'claude-opus-5',
			additionalOptions: { fallbackModel: 'haiku' },
		});
		assert.equal(options.fallbackModel, 'haiku');
	});

	it('refuses a fallback equal to the model, because the SDK would throw before spawning', () => {
		const problem = problemOf({
			model: 'claude-sonnet-5',
			additionalOptions: { fallbackModel: 'claude-sonnet-5' },
		});
		assert.equal(problem.message, 'Fallback Model must be different from Model');
		assert.match(problem.description ?? '', /Pick a different model/);
	});

	it('treats the None option (value "") as no fallback', () => {
		assert.equal(build({ additionalOptions: { fallbackModel: '' } }).fallbackModel, undefined);
	});
});

describe('buildQueryOptions — thinking', () => {
	const cases = [
		['disabled', { type: 'disabled' }],
		['adaptive', { type: 'adaptive' }],
		['summarized', { type: 'adaptive', display: 'summarized' }],
	] as const;

	for (const [selection, expected] of cases) {
		it(`maps ${selection} to the SDK config`, () => {
			assert.deepEqual(build({ additionalOptions: { thinking: selection } }).thinking, expected);
		});
	}

	it('leaves thinking unset for the default selection', () => {
		assert.equal(build({ additionalOptions: { thinking: 'default' } }).thinking, undefined);
		assert.equal(build().thinking, undefined);
	});

	it('sets both thinking and maxThinkingTokens when both are given — the SDK decides precedence', () => {
		const options = build({
			additionalOptions: { thinking: 'adaptive', maxThinkingTokens: 8000 },
		});
		assert.deepEqual(options.thinking, { type: 'adaptive' });
		assert.equal(options.maxThinkingTokens, 8000);
	});
});

describe('buildQueryOptions — numeric bounds', () => {
	it('sets maxThinkingTokens only when positive', () => {
		assert.equal(build({ additionalOptions: { maxThinkingTokens: 8000 } }).maxThinkingTokens, 8000);
		assert.equal(
			build({ additionalOptions: { maxThinkingTokens: 0 } }).maxThinkingTokens,
			undefined,
		);
		assert.equal(
			build({ additionalOptions: { maxThinkingTokens: -1 } }).maxThinkingTokens,
			undefined,
		);
	});

	it('sets maxBudgetUsd only when positive — the only money bound the SDK offers', () => {
		assert.equal(build({ additionalOptions: { maxBudgetUsd: 2.5 } }).maxBudgetUsd, 2.5);
		assert.equal(build({ additionalOptions: { maxBudgetUsd: 0 } }).maxBudgetUsd, undefined);
	});
});

describe('buildQueryOptions — resume and continue', () => {
	it('resumes an explicit session', () => {
		const options = build({ operation: 'continue', sessionId: 'abc-123' });
		assert.equal(options.resume, 'abc-123');
		assert.equal(options.continue, undefined);
	});

	it('falls back to continue when no session id is given', () => {
		const options = build({ operation: 'continue', sessionId: '' });
		assert.equal(options.continue, true);
		assert.equal(options.resume, undefined);
	});

	it('does neither for a query operation, even with a session id present', () => {
		const options = build({ operation: 'query', sessionId: 'abc-123' });
		assert.equal(options.resume, undefined);
		assert.equal(options.continue, undefined);
	});
});

describe('buildQueryOptions — the grace window', () => {
	it('resolves from the timeout and the version-aware default', () => {
		const { ctx } = createFakeContext({
			typeVersion: 1.1,
			params: claudeCodeParams({ timeout: 100 }),
		});
		const outcome = buildQueryOptions(readParams(ctx, 0), deps());
		assert.ok('config' in outcome);
		assert.equal(outcome.config.graceWindow.graceSeconds, 50, 'clamped to floor(timeout/2)');
		assert.equal(outcome.config.graceWindow.hardAbortAtMs, 100_000);
	});

	it('typeVersion 1 gets no wrap-up at all', () => {
		const { ctx } = createFakeContext({
			typeVersion: 1,
			params: claudeCodeParams({ timeout: 100 }),
		});
		const outcome = buildQueryOptions(readParams(ctx, 0), deps());
		assert.ok('config' in outcome);
		assert.equal(outcome.config.graceWindow.wrapUpAtMs, null);
		assert.equal(outcome.config.graceWindow.graceSeconds, 0);
	});
});

describe('buildQueryOptions — the applier table', () => {
	it('has a stable order, so a new option is one entry in a known place', () => {
		assert.deepEqual(APPLIER_NAMES, [
			'planExecution',
			'ultracodeSetting',
			'effortCapture',
			'systemPrompt',
			'executablePath',
			// Next to executablePath: both configure the subprocess itself, not the conversation.
			'authEnv',
			'projectPath',
			'restrictTools',
			// After restrictTools, so it amends a tool set that already exists on the options.
			'stagedAttachments',
			'allowedTools',
			'disallowedTools',
			'fallbackModel',
			'thinking',
			'maxThinkingTokens',
			'maxBudgetUsd',
			'resumeOrContinue',
			// The Chat Model node's four deps-driven appliers. Order matters twice: replace after
			// systemPrompt so an explicit replace wins, and mcpServers after everything that writes
			// options.tools/allowedTools, because it amends both.
			'systemPromptReplace',
			'mcpServers',
			'partialMessages',
			'newSessionId',
		]);
	});

	it('reports which appliers actually did something', () => {
		// effortCapture always runs; nothing else fires on a minimal config.
		assert.deepEqual(applied(), ['effortCapture']);
	});

	it('reports every applier that fired on a fully-loaded config', () => {
		const names = applied(
			{
				effort: 'ultracode',
				operation: 'continue',
				sessionId: 'abc',
				projectPath: '/workspace',
				allowedTools: ['Read'],
				disallowedTools: ['Write'],
				restrictTools: ['Bash'],
				additionalOptions: {
					permissionMode: 'plan',
					allowPlanExecution: true,
					systemPrompt: 'be terse',
					pathToClaudeCodeExecutable: '/usr/bin/claude',
					fallbackModel: 'haiku',
					thinking: 'summarized',
					maxThinkingTokens: 8000,
					maxBudgetUsd: 3,
				},
			},
			// stagedAttachments and authEnv are the two appliers driven by runtime facts rather
			// than parameters, so "fully loaded" has to include a staged directory and a
			// credential — and the Chat Model node's four deps join them for the same reason.
			deps({
				stagedDir: '/tmp/n8n-claude-abc',
				auth: { mode: 'apiKey', secret: 'sk-ant-test' },
				processEnv: { PATH: '/usr/bin' },
				systemPromptReplace: 'you are a poet',
				mcp: {
					servers: { n8n: { type: 'sdk', name: 'n8n', instance: {} as never } },
					toolNames: ['mcp__n8n__calculator'],
				},
				includePartialMessages: true,
				newSessionId: '00000000-0000-5000-8000-000000000001',
			}),
		);
		assert.deepEqual(names, APPLIER_NAMES);
	});

	it('stops at the first problem — a later applier cannot undo an earlier failure', () => {
		// projectPath comes before fallbackModel, so a bad path wins even when both are broken.
		const problem = problemOf(
			{
				projectPath: '/nope',
				model: 'claude-sonnet-5',
				additionalOptions: { fallbackModel: 'claude-sonnet-5' },
			},
			deps({ pathExists: () => false }),
		);
		assert.match(problem.message, /Project Path/);
	});
});

describe('buildQueryOptions — notes for the debug log', () => {
	it('collects what changed instead of logging from inside', () => {
		const { ctx } = createFakeContext({
			params: claudeCodeParams({
				projectPath: '/workspace',
				restrictTools: ['Bash'],
				disallowedTools: ['Write'],
				operation: 'continue',
				sessionId: 'abc',
			}),
		});
		const outcome = buildQueryOptions(readParams(ctx, 0), deps());
		assert.ok('config' in outcome);
		assert.deepEqual(outcome.config.notes, {
			cwd: '/workspace',
			tools: ['Bash'],
			disallowedTools: ['Write'],
			resume: 'abc',
		});
	});
});
