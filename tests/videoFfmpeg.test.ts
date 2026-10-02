import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ffmpegCandidates, findFont } from '../nodes/shared/video/binary';
import { extractFrames, type ExtractSpec } from '../nodes/shared/video/extract';
import { parseProbe } from '../nodes/shared/video/probe';
import type { SamplingSpec } from '../nodes/shared/video/types';

/**
 * A real ffmpeg over generated clips: every strategy, mosaics, subtitles, refusals. It uses
 * VIDEO_TEST_FFMPEG, else whatever the node itself would find (bundled on Linux, then the PATH),
 * and skips when there is none. To run it against the bundled Linux build from a Mac, see
 * CLAUDE.md, "Testing".
 */

const runs = (path: string): boolean => {
	try {
		execFileSync(path, ['-hide_banner', '-version'], { stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
};

const ffmpeg: string | null =
	process.env.VIDEO_TEST_FFMPEG ||
	ffmpegCandidates('').candidates.find((c) => runs(c.path))?.path ||
	null;

const skip = ffmpeg ? false : 'no ffmpeg: none bundled for this platform and none on the PATH';

let dir = '';
const run = (args: string[]) => execFileSync(ffmpeg as string, args, { stdio: 'pipe' });
const sizeOf = (file: string): [number, number] => {
	let stderr = '';
	try {
		run(['-hide_banner', '-i', file]);
	} catch (error) {
		stderr = String((error as { stderr?: Buffer }).stderr ?? '');
	}
	const parsed = parseProbe(stderr, file);
	assert.ok('info' in parsed, stderr);
	return [parsed.info.width, parsed.info.height];
};

const sampling = (over: Partial<SamplingSpec>): SamplingSpec => ({
	mode: 'frames',
	maxImages: 3,
	grid: 2,
	minIntervalSec: 1,
	startSec: null,
	endSec: null,
	framesLongEdge: 640,
	mosaicLongEdge: 1920,
	...over,
});

let work = 0;
const spec = (over: Partial<SamplingSpec>, extra: Partial<ExtractSpec> = {}): ExtractSpec => ({
	sampling: sampling(over),
	burnTimestamps: true,
	includeSubtitles: true,
	ffmpegPath: ffmpeg ?? '',
	timeoutMs: 60_000,
	workDir: join(dir, `work-${work++}`),
	...extra,
});

const clip = () => ({ path: join(dir, 'clip.mp4'), fileName: 'clip.mp4' });

describe('video extraction with the real ffmpeg', { skip }, () => {
	before(() => {
		dir = mkdtempSync(join(tmpdir(), 'video-frames-test-'));
		const font = findFont();
		const number = font
			? `,drawtext=fontfile='${font}':text='%{eif\\:floor(t)\\:d}':fontsize=120:fontcolor=white:x=40:y=40`
			: '';
		// 30 s, 1280x720, a keyframe every 5 s.
		run([
			'-y',
			'-f',
			'lavfi',
			'-i',
			`testsrc2=size=1280x720:rate=30:duration=30${number}`,
			'-c:v',
			'libx264',
			'-preset',
			'ultrafast',
			'-g',
			'150',
			'-pix_fmt',
			'yuv420p',
			join(dir, 'clip.mp4'),
		]);
		writeFileSync(
			join(dir, 'subs.srt'),
			'1\n00:00:01,000 --> 00:00:03,000\nFirst cue\n\n2\n00:00:05,000 --> 00:00:07,000\nSecond cue\n',
		);
		run([
			'-y',
			'-i',
			join(dir, 'clip.mp4'),
			'-i',
			join(dir, 'subs.srt'),
			'-map',
			'0',
			'-map',
			'1',
			'-c',
			'copy',
			'-c:s',
			'mov_text',
			join(dir, 'subtitled.mp4'),
		]);
		run(['-y', '-f', 'lavfi', '-i', 'sine=duration=2', join(dir, 'audio.m4a')]);
		writeFileSync(join(dir, 'garbage.mp4'), 'not a video');
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	it('keyframes: an interval at least the GOP decodes keyframes only, at their own times', async () => {
		const result = await extractFrames(clip(), spec({ maxImages: 3 }));
		assert.ok('images' in result, JSON.stringify(result));
		assert.equal(result.report.strategy, 'keyframes');
		assert.deepEqual(
			result.images.map((i) => i.timestamps),
			[[5], [15], [25]],
		);
		assert.deepEqual(sizeOf(result.images[0].path), [640, 360]);
		assert.equal(result.report.ffmpeg.source, 'configured');
		assert.equal(result.report.video.durationSec, 30);
	});

	it('seek: an interval just under the GOP seeks each target exactly', async () => {
		const result = await extractFrames(clip(), spec({ maxImages: 8 }));
		assert.ok('images' in result, JSON.stringify(result));
		assert.equal(result.report.strategy, 'seek');
		assert.deepEqual(
			result.images.map((i) => i.timestamps[0]),
			[1.875, 5.625, 9.375, 13.125, 16.875, 20.625, 24.375, 28.125],
		);
	});

	it('decode: a dense interval takes the first frame at or after each target', async () => {
		const result = await extractFrames(clip(), spec({ maxImages: 20 }));
		assert.ok('images' in result, JSON.stringify(result));
		assert.equal(result.report.strategy, 'decode');
		assert.equal(result.images.length, 20);
		result.images.forEach((image, i) => {
			const target = (i + 0.5) * 1.5;
			const [at] = image.timestamps;
			assert.ok(at >= target - 0.001 && at < target + 1 / 30 + 0.001, `${at} vs ${target}`);
		});
	});

	it('mosaic from seeks: tiles composed into grid x grid images at the mosaic long edge', async () => {
		const result = await extractFrames(clip(), spec({ mode: 'mosaic', maxImages: 2 }));
		assert.ok('images' in result, JSON.stringify(result));
		assert.equal(result.report.strategy, 'seek');
		assert.equal(result.images.length, 2);
		assert.deepEqual(
			result.images.map((i) => i.timestamps.length),
			[4, 4],
		);
		assert.deepEqual(sizeOf(result.images[0].path), [1920, 1080]);
	});

	it('mosaic from one decode pass: the last image may be partial', async () => {
		// 13 targets at 2.3 s: 13 × 5 / 2 > 30, so one pass beats seeking; 13 = 4 + 4 + 4 + 1.
		const result = await extractFrames(
			clip(),
			spec({ mode: 'mosaic', maxImages: 5, minIntervalSec: 2.3 }),
		);
		assert.ok('images' in result, JSON.stringify(result));
		assert.equal(result.report.strategy, 'decode');
		assert.equal(result.report.coverage.tiles, 13);
		assert.deepEqual(
			result.images.map((i) => i.timestamps.length),
			[4, 4, 4, 1],
		);
		assert.deepEqual(sizeOf(result.images[3].path), [1920, 1080]);
	});

	it('a range narrows the coverage', async () => {
		const result = await extractFrames(clip(), spec({ maxImages: 4, startSec: 10, endSec: 14 }));
		assert.ok('images' in result, JSON.stringify(result));
		assert.equal(result.report.coverage.fromSec, 10);
		assert.equal(result.report.coverage.toSec, 14);
		for (const image of result.images) {
			assert.ok(image.timestamps[0] >= 10 && image.timestamps[0] <= 14);
		}
	});

	it('exports a text subtitle track, without the font tags', async () => {
		const result = await extractFrames(
			{ path: join(dir, 'subtitled.mp4'), fileName: 'subtitled.mp4' },
			spec({ maxImages: 1 }),
		);
		assert.ok('images' in result, JSON.stringify(result));
		assert.equal(result.subtitles?.cues, 2);
		assert.match(result.subtitles?.text ?? '', /^1\n00:00:01,000 --> 00:00:03,000\nFirst cue\n/);
		assert.doesNotMatch(result.subtitles?.text ?? '', /<font/);
	});

	it('refuses audio only and a file that is not a video', async () => {
		const audio = await extractFrames(
			{ path: join(dir, 'audio.m4a'), fileName: 'audio.m4a' },
			spec({}),
		);
		assert.ok('problem' in audio);
		assert.equal(audio.problem.message, 'audio.m4a has no video stream');
		const garbage = await extractFrames(
			{ path: join(dir, 'garbage.mp4'), fileName: 'garbage.mp4' },
			spec({}),
		);
		assert.ok('problem' in garbage);
		assert.match(garbage.problem.message, /^garbage\.mp4 could not be read as a video/);
	});

	it('a configured path that does not exist is the only candidate tried', async () => {
		const result = await extractFrames(clip(), spec({}, { ffmpegPath: join(dir, 'nope') }));
		assert.ok('problem' in result);
		assert.equal(result.problem.message, 'No usable ffmpeg was found');
		assert.match(result.problem.description ?? '', /configured \(.*nope\): not found/);
	});
});
