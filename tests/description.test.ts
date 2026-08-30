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
import {
	EXTENSION_OPTIONS,
	KNOWN_EXTENSIONS,
} from '../nodes/ClaudeCode/description/extensionOptions';
import { ROUTABLE_EXTENSIONS } from '../nodes/ClaudeCode/attachments/mime';

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

	it('declares versions 1 through 1.3, defaulting to 1.3', () => {
		// A node keeps the version it was created with, so raising the default moves new nodes only.
		assert.deepEqual(claudeCodeDescription.version, [1, 1.1, 1.2, 1.3]);
		assert.equal(claudeCodeDescription.defaultVersion, 1.3);
	});

	it('never drops a version — an existing workflow pinned to it would stop loading', () => {
		for (const version of [1, 1.1, 1.2]) {
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
		['authSource', 'options', 'host'],
		['prompt', 'string', ''],
		['sessionId', 'string', ''],
		['model', 'options', 'sonnet'],
		['effort', 'options', 'high'],
		['maxTurns', 'number', undefined],
		['timeout', 'number', undefined],
		['projectPath', 'string', ''],
		['attachAllBinaries', 'options', 'auto'],
		['binaryProperties', 'string', ''],
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

	it('attachAllBinaries offers auto/on/off and defaults to auto', () => {
		// It is `options`, not `boolean`, precisely so the default can stay version-neutral: the
		// Workflow constructor writes schema defaults into every stored workflow before execution,
		// so a boolean defaulting to true would have switched attachments on everywhere. `auto` is
		// resolved against the node version in params.ts instead.
		const field = byName('attachAllBinaries');
		assert.equal(field.type, 'options');
		assert.equal(field.default, 'auto');
		assert.deepEqual(
			optionsOf(field).map((o) => o.value),
			['auto', 'on', 'off'],
		);
	});

	it('binaryProperties shows only when Attach All Binaries is explicitly Off', () => {
		// This is a behaviour contract, not cosmetics. n8n strips a parameter whose display
		// condition is not met before the node reads anything, so with Attach All on Auto the named
		// list is not merely hidden — it resolves empty and nothing is attached. Naming properties
		// therefore requires Off. E2E case40/41 caught this; no unit test could, because the fake
		// context does not model displayOptions.
		assert.deepEqual(byName('binaryProperties').displayOptions, {
			show: { attachAllBinaries: ['off'] },
		});
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
		'allowedExtensions',
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

describe('extension options — the Allowed Extensions filter', () => {
	it('offers a wide curated list rather than a handful', () => {
		assert.ok(KNOWN_EXTENSIONS.length > 100, `only ${KNOWN_EXTENSIONS.length} extensions offered`);
	});

	it('has no duplicates', () => {
		assert.equal(new Set(KNOWN_EXTENSIONS).size, KNOWN_EXTENSIONS.length);
	});

	it('every value is a bare lowercase extension, matching what extensionOf() produces', () => {
		for (const value of KNOWN_EXTENSIONS) {
			assert.match(value, /^[a-z0-9]+$/, `${value} is not a bare lowercase extension`);
		}
	});

	it('covers every extension mime.ts knows how to route', () => {
		// The invariant that stops the two from drifting: if the router can name a type, the filter
		// must be able to select it. Otherwise a user can be handed a file they have no way to
		// filter on, and the only escape is turning the filter off entirely.
		const missing = ROUTABLE_EXTENSIONS.filter((e) => !KNOWN_EXTENSIONS.includes(e));
		assert.deepEqual(
			missing,
			[],
			`mime.ts routes these but Allowed Extensions cannot name them: ${missing.join(', ')}`,
		);
	});

	it('is used by the Allowed Extensions field', () => {
		const field = collectionFields('additionalOptions').find((f) => f.name === 'allowedExtensions');
		assert.equal(field?.type, 'multiOptions');
		assert.deepEqual(field?.default, []);
		assert.equal(field?.options, EXTENSION_OPTIONS);
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
