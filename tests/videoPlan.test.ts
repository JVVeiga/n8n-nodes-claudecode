import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fitSize, planSampling } from '../nodes/shared/video/plan';
import type { SamplingSpec, VideoInfo } from '../nodes/shared/video/types';

const info = (over: Partial<VideoInfo> = {}): VideoInfo => ({
	container: 'mov,mp4',
	durationSec: 600,
	startSec: 0,
	codec: 'h264',
	width: 1920,
	height: 1080,
	rotation: 0,
	fps: 30,
	hasAudio: true,
	subtitles: [],
	...over,
});

const spec = (over: Partial<SamplingSpec> = {}): SamplingSpec => ({
	mode: 'auto',
	maxImages: 20,
	grid: 3,
	minIntervalSec: 1,
	startSec: null,
	endSec: null,
	framesLongEdge: 1280,
	mosaicLongEdge: 1920,
	...over,
});

/** Keyframes every `gap` seconds over `duration`. */
const every = (gap: number, duration = 600) =>
	Array.from({ length: Math.floor(duration / gap) + 1 }, (_, i) => i * gap);

const plan = (i: VideoInfo, keyframes: number[], s: SamplingSpec) => {
	const result = planSampling(i, keyframes, s);
	assert.ok('plan' in result, JSON.stringify(result));
	return result.plan;
};

describe('sampling plan: mode and budget', () => {
	it('auto sends frames for a clip each frame covers at most 5 s of', () => {
		const p = plan(info({ durationSec: 100 }), every(1, 100), spec());
		assert.equal(p.mode, 'frames');
		assert.equal(p.grid, 1);
		assert.equal(p.targets.length, 20);
		assert.equal(p.intervalSec, 5);
	});

	it('auto switches to mosaics past that, filling maxImages × grid² tiles', () => {
		const p = plan(info(), every(2), spec());
		assert.equal(p.mode, 'mosaic');
		assert.equal(p.targets.length, 180);
		assert.equal(p.imageCount, 20);
		assert.ok(Math.abs(p.intervalSec - 600 / 180) < 1e-9);
	});

	it('never samples denser than the minimum interval', () => {
		const p = plan(info({ durationSec: 12 }), every(1, 12), spec());
		assert.equal(p.targets.length, 12);
		assert.equal(p.intervalSec, 1);
	});

	it('a clip shorter than the minimum interval still gets one frame', () => {
		const p = plan(info({ durationSec: 0.4 }), [0], spec());
		assert.deepEqual(p.targets, [0.2]);
		assert.equal(p.imageCount, 1);
	});

	it('targets sit in the middle of each slot', () => {
		const p = plan(
			info({ durationSec: 40 }),
			every(10, 40),
			spec({ mode: 'frames', maxImages: 4 }),
		);
		assert.deepEqual(p.targets, [5, 15, 25, 35]);
	});

	it('a range narrows everything, including the auto mode decision', () => {
		const p = plan(info(), every(1), spec({ startSec: 120, endSec: 160 }));
		assert.equal(p.mode, 'frames');
		assert.equal(p.fromSec, 120);
		assert.equal(p.toSec, 160);
		assert.equal(p.targets[0], 121);
	});

	it('clamps a range to the video', () => {
		const p = plan(info({ durationSec: 30 }), every(1, 30), spec({ startSec: -5, endSec: 99 }));
		assert.deepEqual([p.fromSec, p.toSec], [0, 30]);
	});

	it('refuses an empty range', () => {
		const result = planSampling(info({ durationSec: 30 }), every(1, 30), spec({ startSec: 40 }));
		assert.ok('problem' in result);
		assert.equal(result.problem.message, 'Nothing to extract between 30s and 30s');
	});

	it('the last mosaic counts as an image even when partial', () => {
		const p = plan(info({ durationSec: 13 }), [], spec({ mode: 'mosaic', grid: 2 }));
		assert.equal(p.targets.length, 13);
		assert.equal(p.imageCount, 4);
	});
});

describe('sampling plan: strategy', () => {
	it('keyframes when they are at least as dense as the interval, nearest one per target', () => {
		const p = plan(info({ durationSec: 30 }), every(5, 30), spec({ mode: 'frames', maxImages: 3 }));
		assert.equal(p.strategy, 'keyframes');
		assert.deepEqual(p.keyframeIndices, [1, 3, 5]);
	});

	it('keeps each keyframe once when two targets share it', () => {
		// Targets 5, 15, 25: 15 and 25 are both nearest the keyframe at 20.
		const p = plan(
			info({ durationSec: 30 }),
			[0, 1, 2, 20, 30],
			spec({ mode: 'frames', maxImages: 3 }),
		);
		assert.equal(p.strategy, 'keyframes');
		assert.deepEqual(p.keyframeIndices, [2, 3]);
		assert.equal(p.imageCount, 2);
	});

	it('seek when the GOP is longer than the interval but seeks cost less than a full pass', () => {
		const p = plan(info({ durationSec: 30 }), every(5, 30), spec({ mode: 'frames', maxImages: 8 }));
		assert.equal(p.strategy, 'seek');
		assert.deepEqual(p.keyframeIndices, []);
	});

	it('decode when the seeks would decode more than the whole file', () => {
		const p = plan(info(), every(8.3), spec());
		assert.equal(p.strategy, 'decode');
	});

	it('decode when there are not two keyframes to measure a GOP from', () => {
		const p = plan(info({ durationSec: 30 }), [0], spec({ mode: 'frames', maxImages: 3 }));
		assert.equal(p.strategy, 'decode');
	});

	it('measures the GOP inside the range only', () => {
		const sparseThenDense = [0, 100, 200, ...Array.from({ length: 100 }, (_, i) => 300 + i)];
		const p = plan(
			info({ durationSec: 400 }),
			sparseThenDense,
			spec({ startSec: 300, endSec: 400 }),
		);
		assert.equal(p.strategy, 'keyframes');
	});
});

describe('sampling plan: duration unknown', () => {
	it('estimates it from the last keyframe plus one GOP, and says so', () => {
		const p = plan(info({ durationSec: null }), [0, 3, 6, 9], spec());
		assert.equal(p.durationSec, 12);
		assert.equal(p.durationEstimated, true);
		assert.equal(p.toSec, 12);
	});

	it('refuses a video with no duration and no keyframes', () => {
		const result = planSampling(info({ durationSec: null }), [], spec());
		assert.ok('problem' in result);
	});
});

describe('sampling plan: geometry', () => {
	it('frames fit the long edge, keep the aspect, stay even', () => {
		assert.deepEqual(fitSize(1920, 1080, 1280), [1280, 720]);
		assert.deepEqual(fitSize(1080, 1920, 1280), [720, 1280]);
		assert.deepEqual(fitSize(1366, 768, 1280), [1280, 718]);
	});

	it('never upscales', () => {
		assert.deepEqual(fitSize(640, 360, 1280), [640, 360]);
	});

	it('mosaic tiles divide the mosaic long edge by the grid', () => {
		const p = plan(info(), every(2), spec({ mode: 'mosaic' }));
		assert.deepEqual([p.tileWidth, p.tileHeight], [640, 360]);
	});

	it('a portrait video makes a portrait mosaic', () => {
		const p = plan(info({ width: 1080, height: 1920 }), every(2), spec({ mode: 'mosaic' }));
		assert.deepEqual([p.tileWidth, p.tileHeight], [360, 640]);
	});
});
