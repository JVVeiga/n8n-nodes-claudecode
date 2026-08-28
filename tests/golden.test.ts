import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runItems } from '../nodes/ClaudeCode/ClaudeCode.node';
import { claudeCodeParams, createFakeContext } from './helpers/executeFunctions';
import { withFakeQuery } from './helpers/fakeQuery';
import { streams } from './helpers/sdkMessages';
import type { OutputFormat } from '../nodes/ClaudeCode/types';

/**
 * Golden fixtures: the exact JSON the node emits today, recorded from the current implementation
 * and frozen.
 *
 * This is the mechanism that turns "the refactor changes no behaviour" from a claim into a test.
 * typeVersions 1 and 1.1 must stay byte-identical while execute() is taken apart underneath them
 * (spec R1); typeVersion 1.2 is free to differ, and gets its own fixtures when it lands.
 *
 * Regenerate deliberately, never casually:
 *
 *     UPDATE_GOLDEN=1 npm test
 *
 * A diff in `git status` after that command means behaviour moved. If it moved on purpose, the
 * commit message has to say which fixture changed and why. If a fixture looks WRONG when first
 * recorded, it is still recorded as-is — it freezes the current bug, and the fix belongs in 1.2.
 * Log it in .specs/project/STATE.md instead of quietly correcting it here.
 */

// Resolved against the repo root, not __dirname: tests run from .tmp/tests/, which the build
// wipes. The fixtures have to live in the source tree to be committed and diffed.
const DIR = join(process.cwd(), 'tests', 'fixtures');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

// Streams that end on their own. Timeout streams need the timers to fire and are covered by the
// runner tests, not here.
const CASES = [
	'success',
	'maxTurns',
	'maxTurnsNoText',
	'duringExecution',
	'budgetExceeded',
	'noResult',
	'empty',
	'ultracode',
] as const;

const FORMATS: OutputFormat[] = ['structured', 'messages', 'text'];
const VERSIONS = [1, 1.1];

async function runNode(opts: {
	stream: keyof typeof streams;
	format: OutputFormat;
	typeVersion: number;
}): Promise<unknown> {
	const { ctx } = createFakeContext({
		typeVersion: opts.typeVersion,
		params: claudeCodeParams({ outputFormat: opts.format }),
	});
	return withFakeQuery({ messages: streams[opts.stream]() }, async (_r, query) => {
		const result = await runItems(ctx, { query });
		return result[0];
	});
}

function goldenPath(stream: string, format: string, version: number): string {
	return join(DIR, `v${String(version).replace('.', '_')}-${format}-${stream}.json`);
}

describe('golden output fixtures — typeVersions 1 and 1.1 are frozen', () => {
	if (UPDATE) mkdirSync(DIR, { recursive: true });

	for (const version of VERSIONS) {
		for (const format of FORMATS) {
			for (const stream of CASES) {
				it(`v${version} ${format} ${stream}`, async () => {
					const actual = await runNode({ stream, format, typeVersion: version });
					const serialised = JSON.stringify(actual, null, 2);
					const path = goldenPath(stream, format, version);

					if (UPDATE) {
						writeFileSync(path, serialised + '\n');
						return;
					}

					assert.ok(
						existsSync(path),
						`missing golden fixture ${path} — run UPDATE_GOLDEN=1 npm test to record it`,
					);
					assert.equal(
						serialised,
						readFileSync(path, 'utf8').trimEnd(),
						`output changed for v${version}/${format}/${stream}. If this is deliberate, ` +
							`regenerate with UPDATE_GOLDEN=1 and say why in the commit message.`,
					);
				});
			}
		}
	}
});

describe('golden fixtures — invariants that must hold whatever the shape', () => {
	it('every case emits exactly one item, paired to its input', async () => {
		for (const stream of CASES) {
			const items = (await runNode({ stream, format: 'structured', typeVersion: 1.1 })) as Array<{
				pairedItem: unknown;
			}>;
			assert.equal(items.length, 1, stream);
			assert.deepEqual(items[0].pairedItem, { item: 0 }, stream);
		}
	});

	it('every case carries diagnostics, in every format', async () => {
		for (const format of FORMATS) {
			for (const stream of CASES) {
				const items = (await runNode({ stream, format, typeVersion: 1.1 })) as Array<{
					json: Record<string, unknown>;
				}>;
				assert.ok(items[0].json.diagnostics, `${format}/${stream} lost diagnostics`);
			}
		}
	});

	it('the output is JSON-serialisable — n8n cannot store anything else', async () => {
		for (const format of FORMATS) {
			for (const stream of CASES) {
				const items = await runNode({ stream, format, typeVersion: 1.1 });
				assert.doesNotThrow(() => JSON.stringify(items), `${format}/${stream}`);
			}
		}
	});

	it('v1 and v1.1 agree on the success path — the version only reshapes failures', async () => {
		for (const format of FORMATS) {
			const v1 = await runNode({ stream: 'success', format, typeVersion: 1 });
			const v11 = await runNode({ stream: 'success', format, typeVersion: 1.1 });
			assert.deepEqual(v1, v11, format);
		}
	});
});
