import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { IExecuteFunctions } from 'n8n-workflow';
import { collectAttachments } from '../nodes/ClaudeCode/attachments/collect';
import { prepareAttachments } from '../nodes/ClaudeCode/attachments/prepare';
import type { AttachmentSpec, VideoAttachment } from '../nodes/ClaudeCode/attachments/types';
import {
	framesOnDisk,
	imagesPerVideo,
	prepareVideos,
	videoBlocks,
	type VideoDeps,
} from '../nodes/ClaudeCode/attachments/video';
import { subagentsWithoutRead } from '../nodes/ClaudeCodeAgent/subagents';
import { SUBAGENT_TAG, type SuppliedSubagent } from '../nodes/shared/subagent';
import { readVideoSpec } from '../nodes/ClaudeCode/attachments/videoSpec';
import { readParams, videoFramesByDefault } from '../nodes/ClaudeCode/params';
import { agentVideoFramesByDefault, readAgentParams } from '../nodes/ClaudeCodeAgent/params';
import type { ExtractSpec } from '../nodes/shared/video/extract';
import type { ExtractResult } from '../nodes/shared/video/types';
import { looksLikeVideo } from '../nodes/shared/video/videoType';
import {
	binaryProperty,
	claudeCodeParams,
	createFakeContext,
	itemWithBinary,
} from './helpers/executeFunctions';

const VIDEO = Buffer.from('not really an mp4, the extractor is faked');

const spec = (over: Partial<AttachmentSpec['video']> = {}, all = true): AttachmentSpec => ({
	all,
	names: [],
	inlineTextLimitKb: 256,
	maxAttachmentMb: 50,
	maxAttachmentCount: 16,
	allowedExtensions: [],
	video: { handling: 'frames', mode: 'auto', maxImages: 15, maxVideoMb: 2048, ...over },
});

const report = (over: Partial<ExtractResult['report']> = {}): ExtractResult['report'] => ({
	video: {
		durationSec: 60,
		durationEstimated: false,
		width: 640,
		height: 360,
		codec: 'h264',
		fps: 10,
	},
	mode: 'frames',
	strategy: 'keyframes',
	grid: 1,
	coverage: { fromSec: 0, toSec: 60, tiles: 2, intervalSec: 30 },
	labels: 'burned',
	subtitles: null,
	notes: [],
	ffmpeg: { source: 'bundled', version: 'N-49006' },
	elapsedMs: 120,
	...over,
});

const result = (over: Partial<ExtractResult> = {}): ExtractResult => ({
	images: [
		{ path: '/w/a.jpg', timestamps: [15] },
		{ path: '/w/b.jpg', timestamps: [65.5] },
	],
	subtitles: null,
	report: report(),
	...over,
});

/** Fake extraction; records what it was asked and whether the work dir was cleaned up. */
function fakeVideoDeps(
	answer: () => ExtractResult | { problem: { message: string; description?: string } } = () =>
		result(),
) {
	const calls: { spec: ExtractSpec; written: string }[] = [];
	const dirs: string[] = [];
	const removed: string[] = [];
	const deps: VideoDeps = {
		extract: async (_input, s) => {
			calls.push({ spec: s, written: _input.path });
			return answer();
		},
		makeWorkDir: () => {
			const dir = mkdtempSync(join(tmpdir(), 'video-attach-test-'));
			dirs.push(dir);
			return dir;
		},
		removeWorkDir: (dir) => removed.push(dir),
		readImage: (path) => Buffer.from(`JPEG ${path}`),
		writeBinary: async () => undefined,
	};
	return { deps, calls, dirs, removed };
}

const mp4 = (over: Record<string, string> = {}) =>
	binaryProperty(VIDEO, { fileName: 'rec.mp4', mimeType: 'video/mp4', ...over });

/** A context whose buffer reads are counted, to prove a video is never loaded into memory. */
function countingContext(binaries: Record<string, ReturnType<typeof binaryProperty>>) {
	const fake = createFakeContext({ items: [itemWithBinary(binaries)] });
	const reads: string[] = [];
	const real = fake.ctx.helpers.getBinaryDataBuffer.bind(fake.ctx.helpers);
	const ctx = {
		...fake.ctx,
		getInputData: fake.ctx.getInputData,
		helpers: new Proxy(fake.ctx.helpers, {
			get: (target, prop) =>
				prop === 'getBinaryDataBuffer'
					? async (i: number, name: string) => {
							reads.push(name);
							return real(i, name);
						}
					: (target as never)[prop],
		}),
	} as unknown as IExecuteFunctions;
	return { ctx, reads };
}

describe('video attachments: which handling, by version', () => {
	it('Claude Code converts from 1.5, the Agent from 1.2; earlier versions keep staging', () => {
		assert.equal(videoFramesByDefault(1.4), false);
		assert.equal(videoFramesByDefault(1.5), true);
		assert.equal(agentVideoFramesByDefault(1.1), false);
		assert.equal(agentVideoFramesByDefault(1.2), true);
	});

	it('readParams resolves Auto against the node version, and an explicit choice wins', () => {
		const handling = (typeVersion: number, additionalOptions: Record<string, unknown> = {}) =>
			readParams(
				createFakeContext({ typeVersion, params: claudeCodeParams({ additionalOptions }) }).ctx,
				0,
			).attachments.video.handling;
		assert.equal(handling(1.4), 'stage');
		assert.equal(handling(1.5), 'frames');
		assert.equal(handling(1.4, { videoAttachments: 'frames' }), 'frames');
		assert.equal(handling(1.5, { videoAttachments: 'stage' }), 'stage');
	});

	it('the Agent reads the same options from its own collection', () => {
		const video = (typeVersion: number, options: Record<string, unknown> = {}) =>
			readAgentParams(
				createFakeContext({
					typeVersion,
					params: {
						prompt: 'x',
						model: 'sonnet',
						projectPath: '',
						effort: 'high',
						maxTurns: 5,
						timeout: 60,
						options,
					},
				}).ctx,
				0,
			).run.attachments.video;
		assert.equal(video(1.1).handling, 'stage');
		assert.equal(video(1.2).handling, 'frames');
		assert.deepEqual(video(1.2, { videoSampling: 'mosaic', videoMaxImages: 6, maxVideoMb: 300 }), {
			handling: 'frames',
			mode: 'mosaic',
			maxImages: 6,
			maxVideoMb: 300,
		});
	});

	it('defaults, and values an expression could get wrong', () => {
		assert.deepEqual(readVideoSpec({}, true), {
			handling: 'frames',
			mode: 'auto',
			maxImages: 15,
			maxVideoMb: 2048,
		});
		assert.deepEqual(
			readVideoSpec({ videoSampling: 'x' as never, videoMaxImages: 0, maxVideoMb: -1 }, false),
			{
				handling: 'stage',
				mode: 'auto',
				maxImages: 15,
				maxVideoMb: 2048,
			},
		);
	});
});

describe('video attachments: recognised from metadata, never read into memory', () => {
	it('a declared video type, or a video extension when the type says nothing', () => {
		assert.equal(looksLikeVideo('video/quicktime', 'a.bin'), true);
		assert.equal(looksLikeVideo('application/octet-stream', 'clip.MKV'), true);
		assert.equal(looksLikeVideo('', 'clip.webm'), true);
		assert.equal(looksLikeVideo('application/octet-stream', 'types.ts'), false);
		assert.equal(looksLikeVideo('image/png', 'shot.mp4'), false);
	});

	it('with Convert to Frames a video skips the buffer read and leaves the attachment list', async () => {
		const { ctx, reads } = countingContext({
			clip: mp4(),
			notes: binaryProperty('hello', { fileName: 'notes.txt', mimeType: 'text/plain' }),
		});
		const collected = await collectAttachments(ctx, 0, spec());
		assert.ok('videos' in collected);
		assert.deepEqual(reads, ['notes']);
		assert.deepEqual(
			collected.attachments.map((a) => a.propName),
			['notes'],
		);
		assert.deepEqual(
			collected.videos.map((v) => [v.propName, v.fileName, v.bytes]),
			[['clip', 'rec.mp4', VIDEO.length]],
		);
	});

	it('with Stage the File a video goes through the old path, read and staged', async () => {
		const { ctx, reads } = countingContext({ clip: mp4() });
		const collected = await collectAttachments(ctx, 0, spec({ handling: 'stage' }));
		assert.ok('videos' in collected);
		assert.deepEqual(reads, ['clip']);
		assert.equal(collected.videos.length, 0);
		assert.equal(collected.attachments[0].fileName, 'rec.mp4');
	});

	it('Max Video Size replaces Max Attachment Size for a video', async () => {
		const big = binaryProperty(Buffer.alloc(2 * 1024 * 1024), {
			fileName: 'rec.mp4',
			mimeType: 'video/mp4',
		});
		const fake = createFakeContext({ items: [itemWithBinary({ clip: big })] });
		const under = await collectAttachments(fake.ctx, 0, { ...spec(), maxAttachmentMb: 1 });
		assert.ok(
			'videos' in under && under.videos.length === 1,
			'not held to the 1 MB attachment cap',
		);
		const over = await collectAttachments(fake.ctx, 0, spec({ maxVideoMb: 1 }));
		assert.ok('problem' in over);
		assert.equal(over.problem.message, 'Video attachment "clip" is 2.0 MB, over the limit of 1 MB');
	});

	it('the extension filter still applies first: an unlisted video is skipped, never touched', async () => {
		const { ctx, reads } = countingContext({ clip: mp4() });
		const collected = await collectAttachments(ctx, 0, { ...spec(), allowedExtensions: ['png'] });
		assert.ok('videos' in collected);
		assert.equal(collected.videos.length, 0);
		assert.deepEqual(
			collected.skipped.map((s) => s.extension),
			['mp4'],
		);
		assert.deepEqual(reads, []);
	});
});

describe('video attachments: budget and blocks', () => {
	it('splits the budget across videos, leaves room for other images, never below one', () => {
		assert.equal(imagesPerVideo(15, 0, 1), 15);
		assert.equal(imagesPerVideo(15, 0, 2), 7);
		assert.equal(imagesPerVideo(20, 8, 1), 12);
		assert.equal(imagesPerVideo(15, 19, 3), 1);
		assert.equal(imagesPerVideo(15, 25, 1), 1);
	});

	const video: VideoAttachment = {
		propName: 'clip',
		fileName: 'rec.mp4',
		mimeType: 'video/mp4',
		bytes: 10,
		meta: { data: '', mimeType: 'video/mp4' },
	};

	it('frames: the hint, then each image after its time', () => {
		const blocks = videoBlocks(video, result(), (p) => Buffer.from(p));
		assert.equal(blocks.length, 5);
		assert.match(
			(blocks[0] as { text: string }).text,
			/^Video: 2 frames from the video rec\.mp4 \(00:01:00 long\)/,
		);
		assert.deepEqual(blocks[1], { type: 'text', text: 'rec.mp4 at 00:00:15' });
		assert.deepEqual(blocks[2], {
			type: 'image',
			source: {
				type: 'base64',
				media_type: 'image/jpeg',
				data: Buffer.from('/w/a.jpg').toString('base64'),
			},
		});
		assert.deepEqual(blocks[3], { type: 'text', text: 'rec.mp4 at 00:01:05' });
	});

	it('mosaics list every tile time; subtitles come as a text document before the images', () => {
		const blocks = videoBlocks(
			video,
			result({
				images: [{ path: '/w/m.jpg', timestamps: [1.5, 5, 8.5] }],
				subtitles: { text: '1\n00:00:01,000 --> 00:00:02,000\nHi\n', cues: 1, codec: 'mov_text' },
				report: report({ mode: 'mosaic', grid: 3, subtitles: { codec: 'mov_text', cues: 1 } }),
			}),
			(p) => Buffer.from(p),
		);
		assert.match((blocks[0] as { text: string }).text, /Its subtitles are attached as rec\.srt\.$/);
		assert.deepEqual(blocks[1], {
			type: 'document',
			title: 'rec.srt',
			source: {
				type: 'text',
				media_type: 'text/plain',
				data: '1\n00:00:01,000 --> 00:00:02,000\nHi\n',
			},
		});
		assert.deepEqual(blocks[2], {
			type: 'text',
			text: 'rec.mp4, image 1 of 1: 00:00:01, 00:00:05, 00:00:08',
		});
	});

	it('without burned labels the hint says the times are in the captions', () => {
		const blocks = videoBlocks(video, result({ report: report({ labels: 'none' }) }), (p) =>
			Buffer.from(p),
		);
		assert.match(
			(blocks[0] as { text: string }).text,
			/their times are in the caption before each image/,
		);
	});
});

describe('video attachments: prepareVideos and prepareAttachments', () => {
	const fake = () => createFakeContext({ items: [itemWithBinary({ clip: mp4() })] }).ctx;

	it('asks the core for the per-video budget and removes each work directory', async () => {
		const { deps, calls, dirs, removed } = fakeVideoDeps();
		const videos: VideoAttachment[] = [
			{
				propName: 'a',
				fileName: 'a.mp4',
				mimeType: 'video/mp4',
				bytes: 1,
				meta: { data: '', mimeType: 'video/mp4' },
			},
			{
				propName: 'b',
				fileName: 'b.mp4',
				mimeType: 'video/mp4',
				bytes: 1,
				meta: { data: '', mimeType: 'video/mp4' },
			},
		];
		const out = await prepareVideos(fake(), 0, videos, spec(), 4, { timeoutMs: 60_000 }, deps);
		assert.ok('blocks' in out);
		assert.deepEqual(
			calls.map((c) => c.spec.sampling.maxImages),
			[7, 7],
		);
		assert.equal(calls[0].spec.timeoutMs, 60_000);
		assert.ok(calls[0].written.endsWith('input.mp4'));
		assert.deepEqual(removed, dirs);
		assert.deepEqual(
			out.reports.map((r) => [r.name, r.images, r.strategy]),
			[
				['a.mp4', 2, 'keyframes'],
				['b.mp4', 2, 'keyframes'],
			],
		);
	});

	it('a Timeout that is not positive still gives ffmpeg time', async () => {
		const { deps, calls } = fakeVideoDeps();
		const videos: VideoAttachment[] = [
			{
				propName: 'a',
				fileName: 'a.mp4',
				mimeType: 'video/mp4',
				bytes: 1,
				meta: { data: '', mimeType: 'video/mp4' },
			},
		];
		await prepareVideos(fake(), 0, videos, spec(), 0, { timeoutMs: 0 }, deps);
		assert.equal(calls[0].spec.timeoutMs, 300_000);
	});

	it('an extraction problem fails the item, naming the property; the way to FFmpeg Path is a node away', async () => {
		const { deps, removed, dirs } = fakeVideoDeps(() => ({
			problem: {
				message: 'ffmpeg cannot decode av1 video',
				description: 'Set FFmpeg Path to a newer ffmpeg build.',
			},
		}));
		const out = await prepareAttachments(fake(), 0, spec(), 'What is on screen?', [], {
			timeoutMs: 1000,
			videoDeps: deps,
		});
		assert.ok('problem' in out);
		assert.equal(out.problem.message, 'Video attachment "clip": ffmpeg cannot decode av1 video');
		assert.match(out.problem.description ?? '', /option of the Claude Code Video Frames node/);
		assert.deepEqual(removed, dirs);
	});

	it('the turn: other attachments, then the video, then the prompt; the report gains videos', async () => {
		const { deps } = fakeVideoDeps();
		const ctx = createFakeContext({
			items: [
				itemWithBinary({
					clip: mp4(),
					shot: binaryProperty(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
						fileName: 'shot.png',
						mimeType: 'image/png',
					}),
				}),
			],
		}).ctx;
		const out = await prepareAttachments(ctx, 0, spec(), 'What is on screen?', [], {
			timeoutMs: 1000,
			videoDeps: deps,
		});
		assert.ok('plan' in out);
		const content = out.promptContent as Array<{ type: string; text?: string }>;
		assert.deepEqual(
			content.map((b) => b.type),
			['text', 'image', 'text', 'text', 'image', 'text', 'image', 'text'],
		);
		assert.match(content[2].text ?? '', /^Video: /);
		assert.equal(content[content.length - 1].text, 'What is on screen?');
		const r = out.plan.report;
		assert.equal(r?.count, 2);
		assert.equal(r?.inline.length, 1);
		assert.equal(r?.videos?.[0].name, 'rec.mp4');
		assert.equal(r?.videos?.[0].images, 2);
		assert.equal(out.staged, null);
	});

	it('the shot counts against the budget: 14 images left for the video', async () => {
		const { deps, calls } = fakeVideoDeps();
		const ctx = createFakeContext({
			items: [
				itemWithBinary({
					clip: mp4(),
					shot: binaryProperty(Buffer.from([0x89, 0x50]), {
						fileName: 'shot.png',
						mimeType: 'image/png',
					}),
				}),
			],
		}).ctx;
		await prepareAttachments(ctx, 0, spec({ maxImages: 20 }), 'x', [], {
			timeoutMs: 1000,
			videoDeps: deps,
		});
		assert.equal(calls[0].spec.sampling.maxImages, 19);
	});

	it('only a video: the report exists, with no inline or staged files, and videos', async () => {
		const { deps } = fakeVideoDeps();
		const out = await prepareAttachments(fake(), 0, spec(), 'x', [], {
			timeoutMs: 1000,
			videoDeps: deps,
		});
		assert.ok('plan' in out);
		const { videos, ...rest } = out.plan.report ?? {};
		assert.deepEqual(rest, {
			count: 1,
			totalBytes: VIDEO.length,
			skipped: [],
			inline: [],
			staged: null,
		});
		assert.equal(videos?.length, 1);
	});

	it('no video: the report has no videos key at all (golden fixtures unchanged)', async () => {
		const ctx = createFakeContext({
			items: [
				itemWithBinary({
					notes: binaryProperty('hi', { fileName: 'a.txt', mimeType: 'text/plain' }),
				}),
			],
		}).ctx;
		const out = await prepareAttachments(ctx, 0, spec(), 'x');
		assert.ok('plan' in out);
		assert.ok(!('videos' in (out.plan.report ?? {})));
		assert.ok(!existsSync('/nonexistent'));
	});
});

describe('video frames staged for subagents (Agent 1.3)', () => {
	const video: VideoAttachment = {
		propName: 'clip',
		fileName: 'rec.mp4',
		mimeType: 'video/mp4',
		bytes: 10,
		meta: { data: '', mimeType: 'video/mp4' },
	};

	it('one file per image, named by the time it shows, then an index mapping each to its times', () => {
		const files = framesOnDisk(video, result(), (p) => Buffer.from(`JPEG ${p}`));
		assert.deepEqual(
			files.map((f) => [f.fileName, f.mimeType]),
			[
				['rec-frame-000-00-00-15.jpg', 'image/jpeg'],
				['rec-frame-001-00-01-05.jpg', 'image/jpeg'],
				['rec-frames.json', 'application/json'],
			],
		);
		assert.equal(files[0].buffer.toString(), 'JPEG /w/a.jpg');
		assert.deepEqual(JSON.parse(files[2].buffer.toString()), {
			video: 'rec.mp4',
			mode: 'frames',
			grid: 1,
			images: [
				{ file: 'rec-frame-000-00-00-15.jpg', timestamps: [15] },
				{ file: 'rec-frame-001-00-01-05.jpg', timestamps: [65.5] },
			],
		});
	});

	const withVideo = () => createFakeContext({ items: [itemWithBinary({ clip: mp4() })] }).ctx;

	it('with stageVideoFrames the files land in the staging dir, the report says where, the hint follows the images', async () => {
		const { deps } = fakeVideoDeps();
		const out = await prepareAttachments(withVideo(), 0, spec(), 'Delegate this.', [], {
			timeoutMs: 1000,
			stageVideoFrames: true,
			videoDeps: deps,
		});
		assert.ok('plan' in out);
		try {
			assert.ok(out.staged);
			assert.deepEqual(readdirSync(out.staged.dir).sort(), [
				'rec-frame-000-00-00-15.jpg',
				'rec-frame-001-00-01-05.jpg',
				'rec-frames.json',
			]);
			assert.equal(
				out.plan.report?.staged,
				null,
				'report.staged lists files that could not go inline',
			);
			assert.deepEqual(out.plan.report?.videos?.[0].stagedFrames, {
				dir: out.staged.dir,
				index: 'rec-frames.json',
				files: 2,
				subagentsWithoutRead: [],
			});
			const content = out.promptContent as Array<{ type: string; text?: string }>;
			const hint = content[content.length - 2].text ?? '';
			assert.match(
				hint,
				new RegExp(
					`^<video-frames-on-disk dir="${out.staged.dir}">\\n  rec\\.mp4: 2 images, index rec-frames\\.json`,
				),
			);
			assert.match(hint, /A subagent cannot see the images in this message/);
			assert.ok(!content.some((b) => /attachments-on-disk/.test(b.text ?? '')));
			assert.equal(content[content.length - 1].text, 'Delegate this.');
		} finally {
			out.staged?.cleanup();
		}
		assert.ok(!existsSync(out.staged?.dir ?? ''), 'cleanup removes the frames too');
	});

	it('without it nothing is staged and no hint is added', async () => {
		const { deps } = fakeVideoDeps();
		const out = await prepareAttachments(withVideo(), 0, spec(), 'x', [], {
			timeoutMs: 1000,
			videoDeps: deps,
		});
		assert.ok('plan' in out);
		assert.equal(out.staged, null);
		assert.ok(!('stagedFrames' in (out.plan.report?.videos?.[0] ?? {})));
	});

	it('beside a file staged for its size, both hints appear and report.staged lists only that file', async () => {
		const { deps } = fakeVideoDeps();
		const ctx = createFakeContext({
			items: [
				itemWithBinary({
					clip: mp4(),
					log: binaryProperty('x'.repeat(4096), { fileName: 'big.log', mimeType: 'text/plain' }),
				}),
			],
		}).ctx;
		const out = await prepareAttachments(ctx, 0, { ...spec(), inlineTextLimitKb: 1 }, 'x', [], {
			timeoutMs: 1000,
			stageVideoFrames: true,
			videoDeps: deps,
		});
		assert.ok('plan' in out);
		try {
			assert.deepEqual(
				out.plan.report?.staged?.files.map((f) => f.name),
				['big.log'],
			);
			const texts = (out.promptContent as Array<{ text?: string }>).map((b) => b.text ?? '');
			assert.ok(texts.some((t) => t.startsWith('<attachments-on-disk')));
			assert.ok(texts.some((t) => t.startsWith('<video-frames-on-disk')));
			assert.equal(readdirSync(out.staged?.dir ?? '').length, 4);
		} finally {
			out.staged?.cleanup();
		}
	});

	it('names the enabled subagents that cannot Read: a tool list without it, or Read disallowed', () => {
		const sub = (name: string, definition: Record<string, unknown>, enabled?: boolean) =>
			({
				[SUBAGENT_TAG]: 1,
				name,
				definition: { description: name, prompt: name, ...definition },
				...(enabled === undefined ? {} : { enabled }),
			}) as SuppliedSubagent;
		assert.deepEqual(
			subagentsWithoutRead([
				sub('inherits', {}),
				sub('reader', { tools: ['Read', 'Grep'] }),
				sub('grepper', { tools: ['Grep'] }),
				sub('denied', { disallowedTools: ['Read'] }),
				sub('off', { tools: ['Grep'] }, false),
			]),
			['grepper', 'denied'],
		);
	});
});
