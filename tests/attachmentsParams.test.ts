import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBinaryPropertyNames, readParams } from '../nodes/ClaudeCode/params';
import { claudeCodeParams, createFakeContext, type ParamMap } from './helpers/executeFunctions';

/** The attachment slice of readParams. The rest of the function is covered in params.test.ts. */
const spec = (over: ParamMap = {}) => {
	const { ctx } = createFakeContext({ params: claudeCodeParams(over) });
	return readParams(ctx, 0).attachments;
};

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
	it('is OFF when the parameter is absent — a workflow saved before it existed', () => {
		// This is the upgrade-safety case, and it works because `claudeCodeParams()` does not
		// include `attachAllBinaries` at all: the fake resolves a missing key to the fallback,
		// exactly as n8n does with `get(node.parameters, name, fallbackValue)`.
		//
		// The schema default is `true`, deliberately different. n8n never consults the schema at
		// run time — it is only what the editor writes into a NEWLY added node — so a stored
		// workflow lands here, on `false`, and a package upgrade cannot start attaching files in
		// a workflow that already carries binary data.
		assert.deepEqual(spec(), {
			all: false,
			names: [],
			inlineTextLimitKb: 256,
			maxAttachmentMb: 50,
			maxAttachmentCount: 16,
			allowedExtensions: [],
		});
	});

	it('reads Allowed Extensions, and empty means no filter', () => {
		assert.deepEqual(spec().allowedExtensions, []);
		assert.deepEqual(
			spec({ additionalOptions: { allowedExtensions: ['png', 'csv'] } }).allowedExtensions,
			['png', 'csv'],
		);
	});

	it('reads the toggle and the list', () => {
		assert.equal(spec({ attachAllBinaries: true }).all, true);
		assert.deepEqual(spec({ binaryProperties: 'data, shot' }).names, ['data', 'shot']);
	});

	it('keeps the list even when all is on, so nothing depends on read order', () => {
		const s = spec({ attachAllBinaries: true, binaryProperties: 'data' });
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
		assert.equal(spec({ operation: 'continue', attachAllBinaries: true }).all, true);
	});
});
