import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { NodeOperationError, type IDataObject, type INodeExecutionData } from 'n8n-workflow';
import {
	defaultVideoFramesDeps,
	runVideoFrameItems,
	type VideoFramesDeps,
} from '../nodes/ClaudeCodeVideoFrames/ClaudeCodeVideoFrames.node';
import { videoFramesDescription } from '../nodes/ClaudeCodeVideoFrames/description';
import { clock, promptHint } from '../nodes/ClaudeCodeVideoFrames/output';
import { readVideoFramesParams } from '../nodes/ClaudeCodeVideoFrames/params';
import type { ExtractSpec } from '../nodes/shared/video/extract';
import type { ExtractResult } from '../nodes/shared/video/types';
import { createFakeContext, type ParamMap } from './helpers/executeFunctions';

const VIDEO = Buffer.from('fake mp4 bytes');

const videoItem = (over: IDataObject = {}): INodeExecutionData => ({
	json: { id: 7 },
	binary: {
		data: {
			data: VIDEO.toString('base64'),
			mimeType: 'video/mp4',
			fileName: 'rec.mp4',
			fileExtension: 'mp4',
			...over,
		},
		notes: {
			data: Buffer.from('hi').toString('base64'),
			mimeType: 'text/plain',
			fileName: 'notes.txt',
		},
	},
});

const report = (over: Partial<ExtractResult['report']> = {}): ExtractResult['report'] => ({
	video: {
		durationSec: 600,
		durationEstimated: false,
		width: 1920,
		height: 1080,
		codec: 'h264',
		fps: 30,
	},
	mode: 'mosaic',
	strategy: 'seek',
	grid: 3,
	coverage: { fromSec: 1.667, toSec: 600, tiles: 18, intervalSec: 3.333 },
	labels: 'burned',
	subtitles: null,
	notes: [],
	ffmpeg: { source: 'bundled', version: 'N-49006' },
	elapsedMs: 4200,
	...over,
});

/** A fake extractor that writes two JPEGs where the real one would, and records what it got. */
function fakeExtract(
	result: (
		workDir: string,
	) => ExtractResult | { problem: { message: string; description?: string } } = (workDir) => ({
		images: [
			{ path: join(workDir, 'a.jpg'), timestamps: [1.667, 5, 8.333] },
			{ path: join(workDir, 'b.jpg'), timestamps: [65.2, 68.5] },
		],
		subtitles: null,
		report: report(),
	}),
) {
	const calls: {
		input: { path: string; fileName: string };
		spec: ExtractSpec;
		inputBytes: Buffer;
	}[] = [];
	const dirs: string[] = [];
	const deps: VideoFramesDeps = {
		...defaultVideoFramesDeps,
		makeWorkDir: () => {
			const dir = defaultVideoFramesDeps.makeWorkDir();
			dirs.push(dir);
			return dir;
		},
		extract: async (input, spec) => {
			calls.push({ input, spec, inputBytes: readFileSync(input.path) });
			writeFileSync(join(spec.workDir, 'a.jpg'), 'JPEG-A');
			writeFileSync(join(spec.workDir, 'b.jpg'), 'JPEG-B');
			return result(spec.workDir);
		},
	};
	return { deps, calls, dirs };
}

const run = async (
	opts: {
		items?: INodeExecutionData[];
		params?: ParamMap;
		continueOnFail?: boolean;
		binaryStore?: Record<string, Buffer>;
	},
	deps: VideoFramesDeps,
) => {
	const fake = createFakeContext({
		nodeName: 'Claude Code Video Frames',
		...opts,
		items: opts.items ?? [videoItem()],
	});
	return runVideoFrameItems(fake.ctx, deps);
};

describe('Claude Code Video Frames node', () => {
	it('outputs the images in time order with their times, and drops the video', async () => {
		const { deps, calls, dirs } = fakeExtract();
		const [[out]] = await run({}, deps);
		assert.deepEqual(Object.keys(out.binary ?? {}).sort(), ['frame_000', 'frame_001', 'notes']);
		assert.equal(out.binary?.frame_000.fileName, 'frame_000_00-00-01.jpg');
		assert.equal(out.binary?.frame_001.fileName, 'frame_001_00-01-05.jpg');
		assert.equal(out.binary?.frame_000.mimeType, 'image/jpeg');
		assert.equal(Buffer.from(out.binary?.frame_001.data ?? '', 'base64').toString(), 'JPEG-B');
		assert.deepEqual(out.json.images, [
			{ property: 'frame_000', fileName: 'frame_000_00-00-01.jpg', timestamps: [1.667, 5, 8.333] },
			{ property: 'frame_001', fileName: 'frame_001_00-01-05.jpg', timestamps: [65.2, 68.5] },
		]);
		assert.deepEqual(out.json.video, {
			fileName: 'rec.mp4',
			bytes: VIDEO.length,
			durationSec: 600,
			durationEstimated: false,
			width: 1920,
			height: 1080,
			codec: 'h264',
			fps: 30,
		});
		assert.equal(out.json.strategy, 'seek');
		assert.deepEqual(out.pairedItem, { item: 0 });
		assert.deepEqual(calls[0].inputBytes, VIDEO);
		assert.equal(calls[0].input.fileName, 'rec.mp4');
		assert.ok(calls[0].input.path.endsWith('input.mp4'));
		assert.ok(!existsSync(dirs[0]), 'the work directory is removed');
	});

	it('Keep Input Binary keeps the video on the item', async () => {
		const { deps } = fakeExtract();
		const [[out]] = await run({ params: { options: { keepInputBinary: true } } }, deps);
		assert.ok(out.binary?.data);
	});

	it('streams a binary that lives in the binary store instead of loading it', async () => {
		const { deps, calls } = fakeExtract();
		const stored = Buffer.from('stored video');
		const item = videoItem({ id: 'filesystem-v2:abc', data: 'filesystem-v2' });
		await run({ items: [item], binaryStore: { 'filesystem-v2:abc': stored } }, deps);
		assert.deepEqual(calls[0].inputBytes, stored);
	});

	it('passes the parameters through to extraction', async () => {
		const { deps, calls } = fakeExtract();
		await run(
			{
				params: {
					mode: 'frames',
					maxImages: 8,
					options: {
						grid: 2,
						startSec: 30,
						endSec: 0,
						timeoutSec: 60,
						ffmpegPath: ' /opt/ff ',
						burnTimestamps: false,
					},
				},
			},
			deps,
		);
		const { spec } = calls[0];
		assert.deepEqual(
			{ ...spec, signal: undefined, workDir: undefined },
			{
				sampling: {
					mode: 'frames',
					maxImages: 8,
					grid: 2,
					minIntervalSec: 1,
					startSec: 30,
					endSec: null,
					framesLongEdge: 1280,
					mosaicLongEdge: 1920,
				},
				burnTimestamps: false,
				includeSubtitles: true,
				ffmpegPath: '/opt/ff',
				timeoutMs: 60_000,
				signal: undefined,
				workDir: undefined,
			},
		);
		assert.ok(spec.signal instanceof AbortSignal);
	});

	it('attaches subtitles as an .srt binary and says so in the hint', async () => {
		const { deps } = fakeExtract((workDir) => ({
			images: [{ path: join(workDir, 'a.jpg'), timestamps: [3] }],
			subtitles: { text: '1\n00:00:01,000 --> 00:00:02,000\nHi\n', cues: 1, codec: 'mov_text' },
			report: report({ mode: 'frames', grid: 1, subtitles: { codec: 'mov_text', cues: 1 } }),
		}));
		const [[out]] = await run({}, deps);
		assert.equal(out.binary?.subtitles.fileName, 'rec.srt');
		assert.equal(out.binary?.subtitles.mimeType, 'text/plain');
		assert.deepEqual(out.json.subtitles, { property: 'subtitles', codec: 'mov_text', cues: 1 });
		assert.match(String(out.json.promptHint), /Its subtitles are attached as rec\.srt\.$/);
	});

	it('a missing property fails the item, naming what the item has', async () => {
		const { deps, calls } = fakeExtract();
		await assert.rejects(
			run({ params: { binaryProperty: 'video' } }, deps),
			(error: unknown) =>
				error instanceof NodeOperationError &&
				error.message === 'Input item has no binary property named "video"' &&
				/data, notes/.test(String(error.description)),
		);
		assert.equal(calls.length, 0);
	});

	it('refuses a binary that is plainly not a video before reading it', async () => {
		const { deps, calls } = fakeExtract();
		await assert.rejects(
			run({ items: [videoItem({ mimeType: 'image/png', fileName: 'a.png' })] }, deps),
			{
				message: 'Binary property "data" is image/png, not a video',
			},
		);
		assert.equal(calls.length, 0);
	});

	it('lets ffmpeg decide when n8n reported no useful type', async () => {
		const { deps, calls } = fakeExtract();
		await run(
			{ items: [videoItem({ mimeType: 'application/octet-stream', fileName: 'clip.mkv' })] },
			deps,
		);
		assert.ok(calls[0].input.path.endsWith('input.mkv'));
	});

	it('refuses a video over Max Video Size', async () => {
		const { deps } = fakeExtract();
		const big = Buffer.alloc(2 * 1024 * 1024);
		await assert.rejects(
			run(
				{
					items: [videoItem({ data: big.toString('base64') })],
					params: { options: { maxVideoMb: 1 } },
				},
				deps,
			),
			{ message: 'Binary property "data" is 2.0 MB, over the limit of 1 MB' },
		);
	});

	it('an extraction problem fails the item; continueOnFail turns it into an error item', async () => {
		const { deps, dirs } = fakeExtract(() => ({
			problem: { message: 'ffmpeg cannot decode av1 video', description: 'Set FFmpeg Path.' },
		}));
		await assert.rejects(run({}, deps), { message: 'ffmpeg cannot decode av1 video' });
		const [[out]] = await run({ continueOnFail: true }, deps);
		assert.deepEqual(out.json, {
			error: 'ffmpeg cannot decode av1 video',
			description: 'Set FFmpeg Path.',
		});
		assert.ok(
			dirs.every((dir) => !existsSync(dir)),
			'cleaned up on failure too',
		);
	});

	it('one item per input item', async () => {
		const { deps } = fakeExtract();
		const [out] = await run({ items: [videoItem(), videoItem()] }, deps);
		assert.deepEqual(
			out.map((o) => o.pairedItem),
			[{ item: 0 }, { item: 1 }],
		);
	});
});

describe('Claude Code Video Frames: params and hint', () => {
	const read = (params: ParamMap) => readVideoFramesParams(createFakeContext({ params }).ctx, 0);

	it('defaults', () => {
		const p = read({});
		assert.equal(p.binaryProperty, 'data');
		assert.deepEqual(p.sampling, {
			mode: 'auto',
			maxImages: 15,
			grid: 3,
			minIntervalSec: 1,
			startSec: null,
			endSec: null,
			framesLongEdge: 1280,
			mosaicLongEdge: 1920,
		});
		assert.equal(p.timeoutSec, 300);
		assert.equal(p.maxVideoMb, 2048);
		assert.equal(p.outputPrefix, 'frame');
	});

	it('clamps what an expression could send out of range', () => {
		const p = read({
			mode: 'bogus',
			maxImages: 0,
			options: { grid: 9, minIntervalSec: 0, outputPrefix: ' ' },
		});
		assert.equal(p.sampling.mode, 'auto');
		assert.equal(p.sampling.maxImages, 1);
		assert.equal(p.sampling.grid, 4);
		assert.equal(p.sampling.minIntervalSec, 0.1);
		assert.equal(p.outputPrefix, 'frame');
	});

	it('the hint says how to read the images', () => {
		const result: ExtractResult = {
			images: Array.from({ length: 20 }, () => ({ path: '', timestamps: [] })),
			subtitles: null,
			report: report(),
		};
		assert.equal(
			promptHint(result, 'rec.mp4', null),
			'20 images from the video rec.mp4 (00:10:00 long), each a 3×3 mosaic of moments read left to right, top to bottom, each labelled with its time in the top-left corner. Together they cover 00:00:01–00:10:00, one moment every 3.3 s.',
		);
		const frames = {
			...result,
			images: result.images.slice(0, 1),
			report: report({
				mode: 'frames',
				labels: 'none',
				coverage: { fromSec: 0, toSec: 40, tiles: 1, intervalSec: 40 },
			}),
		};
		assert.equal(
			promptHint(frames, 'a.mp4', null),
			'1 frame from the video a.mp4 (00:10:00 long), in time order, their times are in the image file names, covering 00:00:00–00:00:40, one every 40 s.',
		);
	});

	it('clock', () => {
		assert.equal(clock(0), '00:00:00');
		assert.equal(clock(3725.9), '01:02:05');
	});
});

describe('Claude Code Video Frames: registration', () => {
	it('is registered in package.json, with a codex naming the same node', () => {
		const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
		assert.ok(
			pkg.n8n.nodes.includes('dist/nodes/ClaudeCodeVideoFrames/ClaudeCodeVideoFrames.node.js'),
		);
		assert.ok(pkg.optionalDependencies['@ffmpeg-installer/linux-x64']);
		const codex = JSON.parse(
			readFileSync('nodes/ClaudeCodeVideoFrames/ClaudeCodeVideoFrames.node.json', 'utf8'),
		);
		assert.equal(codex.node, `${pkg.name}.${videoFramesDescription.name}`);
		assert.ok(existsSync('nodes/ClaudeCodeVideoFrames/claudecodevideoframes.svg'));
	});

	it('runs no model and asks for no credentials', () => {
		assert.equal(videoFramesDescription.credentials, undefined);
		assert.ok(!videoFramesDescription.properties.some((p) => p.name === 'authentication'));
	});
});
