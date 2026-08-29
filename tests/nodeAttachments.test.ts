import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { NodeOperationError } from 'n8n-workflow';
import type { INodeExecutionData } from 'n8n-workflow';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { runItems } from '../nodes/ClaudeCode/ClaudeCode.node';
import {
	binaryProperty,
	claudeCodeParams,
	createFakeContext,
	itemWithBinary,
	type ParamMap,
} from './helpers/executeFunctions';
import { withFakeQuery, type FakeQueryOptions } from './helpers/fakeQuery';
import { streams } from './helpers/sdkMessages';

/**
 * The attachment path through the whole node.
 *
 * The unit tests prove each module in isolation; these prove the wiring: that the blocks reach the
 * SDK's prompt stream, that a staged directory reaches `additionalDirectories`, and — the one that
 * matters most — that the temp directory is gone on every exit path.
 */

type ExecOpts = {
	params?: ParamMap;
	items?: INodeExecutionData[];
	continueOnFail?: boolean;
	query?: FakeQueryOptions;
};

/** Drain the prompt stream the node handed to `query()`, returning the turns it produced. */
async function turnsOf(call: unknown): Promise<(string | ContentBlockParam[])[]> {
	const prompt = (call as { prompt: AsyncIterable<{ message: { content: unknown } }> }).prompt;
	const turns: (string | ContentBlockParam[])[] = [];
	for await (const message of prompt) {
		turns.push(message.message.content as string | ContentBlockParam[]);
	}
	return turns;
}

async function exec(opts: ExecOpts = {}) {
	const fake = createFakeContext({
		typeVersion: 1.2,
		continueOnFail: opts.continueOnFail ?? false,
		items: opts.items,
		params: claudeCodeParams(opts.params ?? {}),
	});
	let calls: unknown[] = [];
	const result = await withFakeQuery(
		opts.query ?? { messages: streams.success() },
		(record, query) => {
			const run = runItems(fake.ctx, { query });
			calls = record.calls;
			return run;
		},
	);
	return { items: result[0], fake, calls };
}

const csvItem = (content = 'sku,qty\nWIDGET-7741,412\n') =>
	itemWithBinary({
		data: binaryProperty(content, { fileName: 'export.csv', mimeType: 'text/csv' }),
	});

const pngItem = () =>
	itemWithBinary({
		shot: binaryProperty(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), {
			fileName: 'shot.png',
			mimeType: 'image/png',
		}),
	});

describe('node attachments — off by default', () => {
	it('sends the prompt as a plain string when nothing is attached', async () => {
		const { calls } = await exec({ items: [csvItem()] });
		const turns = await turnsOf(calls[0]);
		assert.equal(typeof turns[0], 'string');
		assert.equal(turns[0], 'Reply with exactly the word: pong.');
	});

	it('sets no additionalDirectories when nothing is staged', async () => {
		const { calls } = await exec({ items: [csvItem()] });
		const options = (calls[0] as { options: { additionalDirectories?: string[] } }).options;
		assert.equal(options.additionalDirectories, undefined);
	});

	it('emits no attachments key in diagnostics', async () => {
		const { items } = await exec({ items: [csvItem()] });
		const diagnostics = (items[0].json as { diagnostics: Record<string, unknown> }).diagnostics;
		assert.equal('attachments' in diagnostics, false);
	});
});

describe('node attachments — inline', () => {
	it('sends a block array with the prompt LAST', async () => {
		const { calls } = await exec({
			items: [csvItem()],
			params: { binaryProperties: 'data' },
		});
		const [turn] = await turnsOf(calls[0]);
		assert.ok(Array.isArray(turn));
		assert.deepEqual(
			turn.map((b) => b.type),
			['document', 'text'],
		);
		assert.equal((turn[1] as { text: string }).text, 'Reply with exactly the word: pong.');
	});

	it('carries the file content verbatim in the document block', async () => {
		const { calls } = await exec({
			items: [csvItem('a,b\n1,2\n')],
			params: { binaryProperties: 'data' },
		});
		const [turn] = await turnsOf(calls[0]);
		assert.ok(Array.isArray(turn));
		assert.deepEqual(turn[0], {
			type: 'document',
			title: 'export.csv',
			source: { type: 'text', media_type: 'text/plain', data: 'a,b\n1,2\n' },
		});
	});

	it('sends an image as a naming block plus an image block', async () => {
		const { calls } = await exec({
			items: [pngItem()],
			params: { binaryProperties: 'shot' },
		});
		const [turn] = await turnsOf(calls[0]);
		assert.ok(Array.isArray(turn));
		assert.deepEqual(
			turn.map((b) => b.type),
			['text', 'image', 'text'],
		);
		assert.match((turn[0] as { text: string }).text, /^Image: shot\.png/);
	});

	it('attaches everything on the item when Attach All Binaries is on', async () => {
		const item = itemWithBinary({
			b: binaryProperty('bee', { fileName: 'b.csv', mimeType: 'text/csv' }),
			a: binaryProperty('ay', { fileName: 'a.csv', mimeType: 'text/csv' }),
		});
		const { calls } = await exec({ items: [item], params: { attachAllBinaries: 'on' } });
		const [turn] = await turnsOf(calls[0]);
		assert.ok(Array.isArray(turn));
		// Sorted by property name, so a.csv comes first regardless of item key order.
		assert.deepEqual(
			turn.filter((b) => b.type === 'document').map((b) => (b as { title: string }).title),
			['a.csv', 'b.csv'],
		);
	});

	it('reports what it sent in diagnostics', async () => {
		const { items } = await exec({
			items: [csvItem('a,b\n')],
			params: { binaryProperties: 'data' },
		});
		const diagnostics = (items[0].json as { diagnostics: { attachments: Record<string, unknown> } })
			.diagnostics;
		assert.deepEqual(diagnostics.attachments, {
			count: 1,
			totalBytes: 4,
			skipped: [],
			inline: [{ name: 'export.csv', mimeType: 'text/csv', bytes: 4, as: 'document-text' }],
			staged: null,
		});
	});

	it('logs the route it chose, when debug is on', async () => {
		const { fake } = await exec({
			items: [csvItem()],
			params: { binaryProperties: 'data', additionalOptions: { debug: true } },
		});
		const start = fake.logsFor('debug').find((l) => l.message.includes('Starting'));
		assert.deepEqual((start?.meta as { attachmentRoutes: unknown }).attachmentRoutes, {
			'export.csv': 'document-text',
		});
	});
});

describe('node attachments — the extension filter', () => {
	const mixed = () =>
		itemWithBinary({
			a_shot: binaryProperty('png-bytes', { fileName: 'shot.png', mimeType: 'image/png' }),
			b_dump: binaryProperty('PK-bytes', { fileName: 'dump.zip', mimeType: 'application/zip' }),
		});

	const onlyPng = { attachAllBinaries: 'on', additionalOptions: { allowedExtensions: ['png'] } };

	it('sends only the allowed extension, and the run continues', async () => {
		const { calls, items } = await exec({ items: [mixed()], params: onlyPng });
		const [turn] = await turnsOf(calls[0]);
		assert.ok(Array.isArray(turn));
		// naming block + image + prompt. No zip, and no staging for it either.
		assert.deepEqual(
			turn.map((b) => b.type),
			['text', 'image', 'text'],
		);
		assert.equal((items[0].json as { success: boolean }).success, true);
	});

	it('reports the skip rather than swallowing it', async () => {
		const { items } = await exec({ items: [mixed()], params: onlyPng });
		const a = (items[0].json as { diagnostics: { attachments: { skipped: unknown[] } } })
			.diagnostics.attachments;
		assert.deepEqual(a.skipped, [{ propName: 'b_dump', fileName: 'dump.zip', extension: 'zip' }]);
	});

	it('never stages a file the filter excluded', async () => {
		const { calls } = await exec({ items: [mixed()], params: onlyPng });
		const options = (calls[0] as { options: { additionalDirectories?: string[] } }).options;
		assert.equal(options.additionalDirectories, undefined);
	});

	it('still reports when EVERY file was filtered out, and the run goes ahead', async () => {
		const { items, calls } = await exec({
			items: [mixed()],
			params: { attachAllBinaries: 'on', additionalOptions: { allowedExtensions: ['pdf'] } },
		});
		// The prompt goes as a plain string — nothing was attached.
		const [turn] = await turnsOf(calls[0]);
		assert.equal(typeof turn, 'string');
		const a = (
			items[0].json as { diagnostics: { attachments: { count: number; skipped: unknown[] } } }
		).diagnostics.attachments;
		assert.equal(a.count, 0);
		assert.equal(a.skipped.length, 2);
	});

	it('logs the skips when debug is on', async () => {
		const { fake } = await exec({
			items: [mixed()],
			params: {
				attachAllBinaries: 'on',
				additionalOptions: { allowedExtensions: ['png'], debug: true },
			},
		});
		const start = fake.logsFor('debug').find((l) => l.message.includes('Starting'));
		assert.deepEqual((start?.meta as { attachmentSkippedFiles: unknown }).attachmentSkippedFiles, [
			'dump.zip (.zip)',
		]);
	});
});

describe('node attachments — staged', () => {
	const bigItem = () =>
		itemWithBinary({
			dump: binaryProperty('x'.repeat(4096), { fileName: 'dump.csv', mimeType: 'text/csv' }),
		});

	const stagedParams = {
		binaryProperties: 'dump',
		additionalOptions: { inlineTextLimitKb: 1 },
	};

	it('passes the directory to the SDK as additionalDirectories', async () => {
		const { calls } = await exec({ items: [bigItem()], params: stagedParams });
		const dirs = (calls[0] as { options: { additionalDirectories?: string[] } }).options
			.additionalDirectories;
		assert.equal(dirs?.length, 1);
		assert.match(dirs?.[0] ?? '', /n8n-claude-[0-9a-f]{16}$/);
	});

	it('tells the model where the file is, instead of inlining it', async () => {
		const { calls } = await exec({ items: [bigItem()], params: stagedParams });
		const [turn] = await turnsOf(calls[0]);
		assert.ok(Array.isArray(turn));
		// Just the hint and the prompt — no document block for the staged file.
		assert.deepEqual(
			turn.map((b) => b.type),
			['text', 'text'],
		);
		const hint = (turn[0] as { text: string }).text;
		assert.match(hint, /dump\.csv \(4 KB, text\/csv\)/);
		assert.match(hint, /Read tool/);
	});

	it('fills the real directory into the diagnostics report', async () => {
		const { items, calls } = await exec({ items: [bigItem()], params: stagedParams });
		const dir = (calls[0] as { options: { additionalDirectories: string[] } }).options
			.additionalDirectories[0];
		const attachments = (
			items[0].json as { diagnostics: { attachments: { staged: { dir: string } } } }
		).diagnostics.attachments;
		assert.equal(attachments.staged.dir, dir);
	});

	it('really writes the bytes — the file exists while the run is in flight', async () => {
		// Asserted from inside the query call, because by the time execute() returns the finally
		// has already removed the directory.
		const fake = createFakeContext({
			typeVersion: 1.2,
			items: [bigItem()],
			params: claudeCodeParams(stagedParams),
		});
		let contentDuringRun = '';
		await withFakeQuery({ messages: streams.success() }, (record, query) => {
			const wrapped: typeof query = (opts) => {
				const dir = (opts as { options: { additionalDirectories: string[] } }).options
					.additionalDirectories[0];
				contentDuringRun = readFileSync(join(dir, 'dump.csv'), 'utf8');
				return query(opts);
			};
			void record;
			return runItems(fake.ctx, { query: wrapped });
		});
		assert.equal(contentDuringRun, 'x'.repeat(4096));
	});
});

describe('node attachments — cleanup on every exit path', () => {
	const bigItem = () =>
		itemWithBinary({
			dump: binaryProperty('y'.repeat(4096), { fileName: 'dump.csv', mimeType: 'text/csv' }),
		});
	const stagedParams = {
		binaryProperties: 'dump',
		additionalOptions: { inlineTextLimitKb: 1 },
	};

	const dirOf = (calls: unknown[]): string =>
		(calls[0] as { options: { additionalDirectories: string[] } }).options.additionalDirectories[0];

	it('removes the directory after a successful item', async () => {
		const { calls } = await exec({ items: [bigItem()], params: stagedParams });
		assert.equal(existsSync(dirOf(calls)), false);
	});

	it('removes the directory when the run errors and the node throws', async () => {
		const fake = createFakeContext({
			typeVersion: 1.2,
			items: [bigItem()],
			params: claudeCodeParams(stagedParams),
		});
		let dir = '';
		await assert.rejects(() =>
			withFakeQuery(
				{ messages: streams.success(), throwAfter: new Error('boom') },
				(record, query) => {
					const wrapped: typeof query = (opts) => {
						dir = (opts as { options: { additionalDirectories: string[] } }).options
							.additionalDirectories[0];
						return query(opts);
					};
					void record;
					return runItems(fake.ctx, { query: wrapped });
				},
			),
		);
		assert.notEqual(dir, '');
		assert.equal(existsSync(dir), false);
	});

	it('removes the directory when the item fails softly under continueOnFail', async () => {
		const { items, calls } = await exec({
			items: [bigItem()],
			params: stagedParams,
			continueOnFail: true,
			query: { messages: streams.success(), throwAfter: new Error('boom') },
		});
		assert.equal(existsSync(dirOf(calls)), false);
		// typeVersion >= 1.1 shapes a soft failure as { error, message, details } — see
		// timeout.ts shapeFailureJson. There is no top-level success field on this path.
		assert.match(String((items[0].json as { error: string }).error), /boom/);
	});

	it('removes the directory when the run times out', async () => {
		// No abortSignal: the fake watches the controller the node put on the options, so a hang
		// ends when the node's own hard timer aborts. Passing an unrelated signal would leave the
		// stream hanging forever.
		const { calls } = await exec({
			items: [bigItem()],
			params: {
				...stagedParams,
				timeout: 1,
				additionalOptions: { ...stagedParams.additionalOptions, wrapUpGraceSeconds: 0 },
			},
			continueOnFail: true,
			query: { messages: [], hang: true },
		});
		assert.equal(existsSync(dirOf(calls)), false);
	});

	it('removes nothing and breaks nothing when there was no staging', async () => {
		const { items } = await exec({ items: [csvItem()], params: { binaryProperties: 'data' } });
		assert.equal(items.length, 1);
	});
});

describe('node attachments — failures reach the user', () => {
	it('throws a NodeOperationError naming the missing property', async () => {
		await assert.rejects(
			() => exec({ items: [csvItem()], params: { binaryProperties: 'screenshot' } }),
			(error: unknown) => {
				assert.ok(error instanceof NodeOperationError);
				assert.match(error.message, /no binary property named "screenshot"/);
				return true;
			},
		);
	});

	it('returns an error item instead, under continueOnFail', async () => {
		const { items } = await exec({
			items: [csvItem()],
			params: { binaryProperties: 'screenshot' },
			continueOnFail: true,
		});
		assert.equal(items.length, 1);
		assert.match((items[0].json as { error: string }).error, /no binary property named/);
		assert.equal(
			((items[0].json as { details: { errorType: string } }).details ?? {}).errorType,
			'execution_error',
		);
	});

	it('fails the item before spending anything — query is never called', async () => {
		const { calls } = await exec({
			items: [csvItem()],
			params: { binaryProperties: 'nope' },
			continueOnFail: true,
		});
		assert.deepEqual(calls, []);
	});

	it('pairs the failure with the right item index', async () => {
		const { items } = await exec({
			items: [csvItem(), csvItem()],
			params: { binaryProperties: 'nope' },
			continueOnFail: true,
		});
		assert.equal(items.length, 2);
		assert.deepEqual(
			items.map((i) => i.pairedItem),
			[{ item: 0 }, { item: 1 }],
		);
	});
});

describe('node attachments — per item', () => {
	it('reads each item its own binaries', async () => {
		const { calls } = await exec({
			items: [csvItem('first\n'), csvItem('second\n')],
			params: { binaryProperties: 'data' },
		});
		assert.equal(calls.length, 2);
		const [firstTurn] = await turnsOf(calls[0]);
		const [secondTurn] = await turnsOf(calls[1]);
		assert.ok(Array.isArray(firstTurn) && Array.isArray(secondTurn));
		assert.equal((firstTurn[0] as { source: { data: string } }).source.data, 'first\n');
		assert.equal((secondTurn[0] as { source: { data: string } }).source.data, 'second\n');
	});
});
