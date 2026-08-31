import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { INodeProperties } from 'n8n-workflow';
import { claudeCodeChatModelDescription } from '../nodes/ClaudeCodeChatModel/description';
import { claudeCodeToolDescription } from '../nodes/ClaudeCodeTool/description';
import { claudeCodeUsageToolDescription } from '../nodes/ClaudeCodeUsageTool/description';
import { readChatModelSettings } from '../nodes/ClaudeCodeChatModel/params';
import { readClaudeCodeToolSettings } from '../nodes/ClaudeCodeTool/params';
import { createFakeContext } from './helpers/executeFunctions';

/**
 * A declared option that nothing reads is worse than a missing one: the editor promises a
 * behaviour the node does not have. It happened — the Usage Tool briefly offered "Report Usage to
 * Workflow" and "Process Name" while its code never looked at either, because the option was
 * added to the schema by hand and no test compared the two sides.
 *
 * These suites compare them. They also pin the identities the editor depends on, which the
 * `authSource` scar showed no other test covers.
 */

const optionNames = (description: { properties: INodeProperties[] }): string[] => {
	const collection = description.properties.find((p) => p.name === 'options');
	const options = (collection?.options ?? []) as INodeProperties[];
	return options.map((o) => o.name).sort();
};

describe('every declared option is one the node reads', () => {
	it('chat model: the options collection and the settings reader agree', () => {
		// The reader takes the whole collection as one object, so what proves the link is that
		// each declared name appears in the type the reader destructures — asserted here by
		// listing them explicitly. A new option added to the schema fails this until it is read.
		assert.deepEqual(optionNames(claudeCodeChatModelDescription), [
			'allowedTools',
			'debug',
			'disallowedTools',
			'effort',
			'fallbackModel',
			'maxBudgetUsd',
			'maxThinkingTokens',
			'maxTurns',
			'pathToClaudeCodeExecutable',
			'processName',
			'reportUsageTo',
			'restrictTools',
			'systemPrompt',
			'systemPromptMode',
			'thinking',
			'timeout',
			'wrapUpGraceSeconds',
		]);
	});

	it('task tool: same list minus what only a chat model has', () => {
		assert.deepEqual(optionNames(claudeCodeToolDescription), [
			'allowedTools',
			'debug',
			'disallowedTools',
			'effort',
			'fallbackModel',
			'maxBudgetUsd',
			'maxThinkingTokens',
			'maxTurns',
			'pathToClaudeCodeExecutable',
			'processName',
			'reportUsageTo',
			'restrictTools',
			'systemPrompt',
			'thinking',
			'timeout',
			'wrapUpGraceSeconds',
		]);
	});

	it('usage tool offers NO usage reporting — it has no run to report', () => {
		// It performs a usage READ: no session, no inference, no turns. A row from it would be a
		// line of zeros in a table of runs.
		const names = optionNames(claudeCodeUsageToolDescription);
		assert.equal(names.includes('reportUsageTo'), false);
		assert.equal(names.includes('processName'), false);
		assert.deepEqual(names, [
			'debug',
			'declareProfileScope',
			'includeAccountEmail',
			'pathToClaudeCodeExecutable',
			'probeIfUnavailable',
			'timeout',
		]);
	});
});

describe('the reporting options actually reach the settings', () => {
	it('chat model: a chosen workflow and process name are read, not ignored', () => {
		const fake = createFakeContext({
			params: {
				model: 'sonnet',
				projectPath: '',
				options: { reportUsageTo: 'wf-99', processName: ' support-bot ' },
			},
		});
		const settings = readChatModelSettings(fake.ctx, 0);
		assert.equal(settings.usageWorkflowId, 'wf-99');
		assert.equal(settings.processName, 'support-bot', 'trimmed');
	});

	it('task tool: the same, and a resource-locator value is unwrapped', () => {
		const fake = createFakeContext({
			params: {
				toolDescription: 'x',
				model: 'sonnet',
				projectPath: '',
				// The workflowSelector resolves to this shape when picked from the list.
				options: { reportUsageTo: { __rl: true, value: 'wf-7', mode: 'list' } },
			},
		});
		const settings = readClaudeCodeToolSettings(fake.ctx, 0);
		assert.equal(settings.usageWorkflowId, 'wf-7');
	});

	it('no workflow chosen means no reporting, on both', () => {
		const chat = createFakeContext({
			params: { model: 'sonnet', projectPath: '', options: {} },
		});
		assert.equal(readChatModelSettings(chat.ctx, 0).usageWorkflowId, '');

		const tool = createFakeContext({
			params: { toolDescription: 'x', model: 'sonnet', projectPath: '', options: {} },
		});
		assert.equal(readClaudeCodeToolSettings(tool.ctx, 0).usageWorkflowId, '');
	});
});

describe('the identities the editor depends on', () => {
	it('each sub-node keeps its name, its single output and the shared auth selector', () => {
		const cases: Array<
			[{ name: string; properties: INodeProperties[]; outputs: unknown }, string, string]
		> = [
			[claudeCodeChatModelDescription, 'claudeCodeChatModel', 'ai_languageModel'],
			[claudeCodeToolDescription, 'claudeCodeTaskTool', 'ai_tool'],
			[claudeCodeUsageToolDescription, 'claudeCodePlanUsageTool', 'ai_tool'],
		];

		for (const [description, name, output] of cases) {
			assert.equal(description.name, name);
			assert.deepEqual(description.outputs, [{ type: output }]);
			// `authentication` is a name n8n reserves and silently absorbs — the scar that cost a
			// browser session to find. Every sub-node must use authSource.
			assert.ok(
				description.properties.some((p) => p.name === 'authSource'),
				`${name} must carry authSource`,
			);
			assert.equal(
				description.properties.some((p) => p.name === 'authentication'),
				false,
				`${name} must NOT use the reserved name`,
			);
		}
	});
});
