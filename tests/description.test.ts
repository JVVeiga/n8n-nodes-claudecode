import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { INodeProperties, INodePropertyOptions } from 'n8n-workflow';
import { claudeCodeDescription } from '../nodes/ClaudeCode/description/properties';
import {
	FALLBACK_MODEL_OPTIONS,
	MODELS,
	MODEL_OPTIONS,
} from '../nodes/ClaudeCode/description/models';
import { BUILT_IN_TOOL_OPTIONS } from '../nodes/ClaudeCode/description/toolOptions';

const props = claudeCodeDescription.properties;
const byName = (name: string): INodeProperties => {
	const found = props.find((p) => p.name === name);
	assert.ok(found, `no top-level parameter named '${name}'`);
	return found;
};
const optionsOf = (p: INodeProperties): INodePropertyOptions[] =>
	(p.options ?? []) as INodePropertyOptions[];

const collectionFields = (name: string): INodeProperties[] =>
	(byName(name).options ?? []) as INodeProperties[];

/**
 * The schema is the node's contract with every workflow already built on it. A renamed parameter
 * or a changed default silently breaks stored workflows, so the shape is asserted rather than
 * reviewed (spec R2).
 */

describe('node description — identity', () => {
	it('keeps the name workflows are stored against', () => {
		assert.equal(claudeCodeDescription.name, 'claudeCode');
		assert.equal(claudeCodeDescription.displayName, 'Claude Code');
	});

	it('declares versions 1, 1.1 and 1.2, defaulting to 1.2', () => {
		// A node keeps the version it was created with, so raising the default moves new nodes only.
		assert.deepEqual(claudeCodeDescription.version, [1, 1.1, 1.2]);
		assert.equal(claudeCodeDescription.defaultVersion, 1.2);
	});

	it('never drops a version — an existing workflow pinned to it would stop loading', () => {
		for (const version of [1, 1.1]) {
			assert.ok(
				(claudeCodeDescription.version as number[]).includes(version),
				`typeVersion ${version} disappeared`,
			);
		}
	});

	it('stays usable as a tool and keeps one main input and output', () => {
		assert.equal(claudeCodeDescription.usableAsTool, true);
		assert.equal(claudeCodeDescription.inputs.length, 1);
		assert.equal(claudeCodeDescription.outputs.length, 1);
	});
});

describe('node description — top-level parameters', () => {
	// The full list, spelled out. A parameter added or removed without updating this fails here,
	// which is the point: the UI contract should not change by accident.
	const EXPECTED = [
		['operation', 'options', 'query'],
		['prompt', 'string', ''],
		['attachAllBinaries', 'boolean', false],
		['binaryProperties', 'string', ''],
		['sessionId', 'string', ''],
		['model', 'options', 'sonnet'],
		['effort', 'options', 'high'],
		['maxTurns', 'number', undefined],
		['timeout', 'number', undefined],
		['projectPath', 'string', ''],
		['outputFormat', 'options', undefined],
		['allowedTools', 'multiOptions', undefined],
		['disallowedTools', 'multiOptions', undefined],
		['restrictTools', 'multiOptions', undefined],
		['additionalOptions', 'collection', undefined],
	] as const;

	it('has exactly the expected parameters, in order', () => {
		assert.deepEqual(
			props.map((p) => p.name),
			EXPECTED.map(([name]) => name),
		);
	});

	for (const [name, type, dflt] of EXPECTED) {
		it(`${name} keeps its type${dflt === undefined ? '' : ' and default'}`, () => {
			const p = byName(name);
			assert.equal(p.type, type);
			if (dflt !== undefined) assert.equal(p.default, dflt);
		});
	}

	it('sessionId only shows for the continue operation', () => {
		assert.deepEqual(byName('sessionId').displayOptions, { show: { operation: ['continue'] } });
	});

	it('prompt stays required', () => {
		assert.equal(byName('prompt').required, true);
	});
});

describe('node description — additionalOptions collection', () => {
	const EXPECTED = [
		'pathToClaudeCodeExecutable',
		'outputEnvelope',
		'debug',
		'allowPlanExecution',
		'includeTranscript',
		'wrapUpGraceSeconds',
		'inlineTextLimitKb',
		'maxAttachmentMb',
		'maxAttachmentCount',
		'maxBudgetUsd',
		'fallbackModel',
		'thinking',
		'maxThinkingTokens',
		'permissionMode',
		'systemPrompt',
	];

	it('has exactly the expected fields', () => {
		assert.deepEqual(
			collectionFields('additionalOptions').map((f) => f.name),
			EXPECTED,
		);
	});

	it('permissionMode still defaults to bypassPermissions — n8n runs headless', () => {
		const field = collectionFields('additionalOptions').find((f) => f.name === 'permissionMode');
		assert.equal(field?.default, 'bypassPermissions');
	});
});

describe('model options — one list, two selectors', () => {
	it('the Model selector uses MODEL_OPTIONS', () => {
		assert.equal(optionsOf(byName('model')), MODEL_OPTIONS);
	});

	it('the Fallback Model selector uses FALLBACK_MODEL_OPTIONS', () => {
		const field = collectionFields('additionalOptions').find((f) => f.name === 'fallbackModel');
		assert.equal(field?.options, FALLBACK_MODEL_OPTIONS);
	});

	it('every model is offered as a fallback — the two lists cannot drift again', () => {
		const primary = MODEL_OPTIONS.map((o) => o.value);
		const fallback = FALLBACK_MODEL_OPTIONS.map((o) => o.value);
		for (const value of primary) {
			assert.ok(fallback.includes(value), `${value} is selectable as Model but not as Fallback`);
		}
	});

	it('the fallback list is the model list plus None, and nothing else', () => {
		assert.deepEqual(
			FALLBACK_MODEL_OPTIONS.map((o) => o.value),
			['', ...MODEL_OPTIONS.map((o) => o.value)],
		);
	});

	it('keeps the models that existed before the lists were merged', () => {
		// Regression guard: Opus 4.7 and Fable 5 were selectable as Model but were missing from
		// Fallback Model. Merging the lists fixed that; this asserts none of them vanished instead.
		for (const value of [
			'sonnet',
			'opus',
			'haiku',
			'claude-opus-5',
			'claude-opus-4-8',
			'claude-opus-4-7',
			'claude-sonnet-5',
			'claude-haiku-4-5',
			'claude-fable-5',
		]) {
			assert.ok(
				MODELS.some((m) => m.value === value),
				`${value} disappeared from the model list`,
			);
		}
	});

	it('has no duplicate model values', () => {
		const values = MODELS.map((m) => m.value);
		assert.equal(new Set(values).size, values.length);
	});

	it('every model carries both descriptions the two selectors need', () => {
		for (const m of MODELS) {
			assert.ok(m.description.length > 0, `${m.value} has no description`);
			assert.ok(m.short.length > 0, `${m.value} has no short name`);
		}
	});
});

describe('tool options — one list, three selectors', () => {
	for (const name of ['allowedTools', 'disallowedTools', 'restrictTools']) {
		it(`${name} uses BUILT_IN_TOOL_OPTIONS`, () => {
			assert.equal(optionsOf(byName(name)), BUILT_IN_TOOL_OPTIONS);
		});
	}

	it('includes the tools Ultracode depends on', () => {
		// config.ts adds these back when a restriction would otherwise disable orchestration, so
		// they have to be selectable in the first place.
		const values = BUILT_IN_TOOL_OPTIONS.map((o) => o.value);
		assert.ok(values.includes('Workflow'));
		assert.ok(values.includes('Task'));
	});

	it('has no duplicate tool values', () => {
		const values = BUILT_IN_TOOL_OPTIONS.map((o) => o.value);
		assert.equal(new Set(values).size, values.length);
	});
});
