import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	attachAllByDefault,
	parseBinaryPropertyNames,
	readParams,
	resolveAttachAll,
} from '../nodes/ClaudeCode/params';
import { claudeCodeParams, createFakeContext, type ParamMap } from './helpers/executeFunctions';

/** The attachment slice of readParams. The rest of the function is covered in params.test.ts. */
const spec = (over: ParamMap = {}, typeVersion = 1.3) => {
	const { ctx } = createFakeContext({ typeVersion, params: claudeCodeParams(over) });
	return readParams(ctx, 0).attachments;
};

describe('resolveAttachAll — why auto exists', () => {
	// A schema default cannot be version-aware: the Workflow constructor writes every schema
	// default into node.parameters before execution, so a parameter absent from a stored workflow
	// still arrives carrying the schema's value. E2E case50 proved a plain `default: true` switched
	// attachments on in a workflow saved before the feature existed. `auto` moves the decision here.
	it('auto is ON from 1.3 and OFF below it', () => {
		assert.equal(attachAllByDefault(1.3), true);
		assert.equal(attachAllByDefault(1.2), false);
		assert.equal(attachAllByDefault(1.1), false);
		assert.equal(attachAllByDefault(1), false);
	});

	it('a future version keeps it on', () => {
		assert.equal(attachAllByDefault(1.4), true);
		assert.equal(attachAllByDefault(2), true);
	});

	it('on and off ignore the version entirely', () => {
		for (const version of [1, 1.1, 1.2, 1.3]) {
			assert.equal(resolveAttachAll('on', version), true, `on at ${version}`);
			assert.equal(resolveAttachAll('off', version), false, `off at ${version}`);
		}
	});
});

describe('parseBinaryPropertyNames', () => {
	it('splits on commas, spaces, and both together', () => {
		assert.deepEqual(parseBinaryPropertyNames('a,b'), ['a', 'b']);
		assert.deepEqual(parseBinaryPropertyNames('a b'), ['a', 'b']);
		assert.deepEqual(parseBinaryPropertyNames('a, b,  c'), ['a', 'b', 'c']);
	});

	it('drops empties rather than producing blank names', () => {
		assert.deepEqual(parseBinaryPropertyNames(',,a,,'), ['a']);
		assert.deepEqual(parseBinaryPropertyNames('   '), []);
		assert.deepEqual(parseBinaryPropertyNames(''), []);
	});

	it('trims a newline-separated list, which is what a paste produces', () => {
		assert.deepEqual(parseBinaryPropertyNames('a\nb\n'), ['a', 'b']);
	});
});

describe('readParams — the attachment spec', () => {
	it('a 1.2 node left on Auto does not attach — the upgrade-safety case', () => {
		// The exact situation e2e case50 exercises: a workflow built before this feature, whose
		// node is pinned at 1.2, carrying binary data. It must stay off.
		assert.equal(spec({}, 1.2).all, false);
		assert.equal(spec({ attachAllBinaries: 'auto' }, 1.2).all, false);
	});

	it('a 1.3 node left on Auto does attach', () => {
		assert.equal(spec({}, 1.3).all, true);
	});

	it('an explicit On works on an old node, so 1.2 can opt in without being recreated', () => {
		assert.equal(spec({ attachAllBinaries: 'on' }, 1.2).all, true);
	});

	it('an explicit Off works on a new node', () => {
		assert.equal(spec({ attachAllBinaries: 'off' }, 1.3).all, false);
	});

	it('falls back to auto when the parameter is not in the schema at all', () => {
		// `claudeCodeParams()` omits attachAllBinaries, so this exercises the getNodeParameter
		// fallback rather than the schema default. It resolves to `auto`, which then resolves
		// against the version — which is why the two tests above pin 1.2 and 1.3 separately.
		assert.equal(spec({}, 1.2).all, false);
		assert.equal(spec({}, 1.3).all, true);
	});

	it('reads the toggle and the list', () => {
		assert.equal(spec({ attachAllBinaries: 'on' }).all, true);
		assert.deepEqual(spec({ binaryProperties: 'data, shot' }).names, ['data', 'shot']);
	});

	it('keeps the list even when all is on, so nothing depends on read order', () => {
		const s = spec({ attachAllBinaries: 'on', binaryProperties: 'data' });
		assert.equal(s.all, true);
		assert.deepEqual(s.names, ['data']);
	});

	it('takes the limits from Additional Options', () => {
		const s = spec({
			additionalOptions: { inlineTextLimitKb: 64, maxAttachmentMb: 10, maxAttachmentCount: 4 },
		});
		assert.equal(s.inlineTextLimitKb, 64);
		assert.equal(s.maxAttachmentMb, 10);
		assert.equal(s.maxAttachmentCount, 4);
	});

	it('preserves a text limit of 0 — it means "stage every text file", not "unset"', () => {
		// `||` would turn this back into 256 and silently inline everything.
		assert.equal(spec({ additionalOptions: { inlineTextLimitKb: 0 } }).inlineTextLimitKb, 0);
	});

	it('is read for the continue operation too, not just query', () => {
		assert.equal(spec({ operation: 'continue', attachAllBinaries: 'on' }).all, true);
	});
});
