import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	composeArgs,
	escapedHms,
	isUsableFontPath,
	keyframeScanArgs,
	probeArgs,
	seekArgs,
	selectPassArgs,
	subtitleArgs,
} from '../nodes/shared/video/args';
import type { SamplingPlan } from '../nodes/shared/video/types';

const plan = (over: Partial<SamplingPlan> = {}): SamplingPlan => ({
	mode: 'mosaic',
	grid: 3,
	strategy: 'decode',
	targets: [1.5, 4.5],
	keyframeIndices: [],
	intervalSec: 3,
	fromSec: 0,
	toSec: 6,
	tileWidth: 640,
	tileHeight: 360,
	imageCount: 1,
	durationSec: 6,
	durationEstimated: false,
	...over,
});

const FONT = '/usr/share/fonts/truetype/msttcorefonts/Arial.ttf';
const LABEL_STYLE = ':fontsize=28:fontcolor=yellow:box=1:boxcolor=black@0.7:x=8:y=8';

describe('ffmpeg argv', () => {
	it('decode pass: first frame at or after each target, real-time label, showinfo, tile', () => {
		assert.deepEqual(
			selectPassArgs('/in.mp4', plan(), 0, { font: FONT, startSec: 0 }, '/out/img_%03d.jpg'),
			[
				'-hide_banner',
				'-nostats',
				'-y',
				'-i',
				'/in.mp4',
				'-an',
				'-sn',
				'-dn',
				'-vf',
				"select='gte(t\\,1.500)*lt(prev_t\\,1.500)+gte(t\\,4.500)*lt(prev_t\\,4.500)'," +
					'scale=640:360,' +
					`drawtext=fontfile='${FONT}':text='%{pts\\:hms}'${LABEL_STYLE},` +
					'showinfo,tile=3x3',
				'-vsync',
				'vfr',
				'-q:v',
				'3',
				'/out/img_%03d.jpg',
			],
		);
	});

	it('keyframes pass: keyframe-only decode, select by keyframe ordinal; frames have no tile', () => {
		const args = selectPassArgs(
			'/in.mp4',
			plan({ mode: 'frames', grid: 1, strategy: 'keyframes', keyframeIndices: [1, 3] }),
			0,
			null,
			'/o/img_%03d.jpg',
		);
		assert.deepEqual(args.slice(3, 7), ['-skip_frame', 'nokey', '-i', '/in.mp4']);
		assert.equal(
			args[args.indexOf('-vf') + 1],
			"select='eq(n\\,1)+eq(n\\,3)',scale=640:360,showinfo",
		);
	});

	it('a late container start shifts select into pts time and the label back to zero', () => {
		const args = selectPassArgs(
			'/in.ts',
			plan({ targets: [1] }),
			1.4,
			{ font: FONT, startSec: 1.4 },
			'/o',
		);
		const vf = args[args.indexOf('-vf') + 1];
		assert.match(vf, /gte\(t\\,2\.400\)/);
		assert.match(vf, /%\{pts\\:hms\\:-1\.400000\}/);
	});

	it('seek: -ss before -i (accurate), one frame, the literal time as label', () => {
		assert.deepEqual(
			seekArgs('/in.mp4', plan({ mode: 'frames' }), 65.25, { font: FONT, startSec: 0 }, '/o/1.jpg'),
			[
				'-hide_banner',
				'-nostats',
				'-y',
				'-ss',
				'65.250',
				'-i',
				'/in.mp4',
				'-an',
				'-sn',
				'-dn',
				'-frames:v',
				'1',
				'-vf',
				`scale=640:360,drawtext=fontfile='${FONT}':text='00\\:01\\:05.250'${LABEL_STYLE}`,
				'-q:v',
				'3',
				'/o/1.jpg',
			],
		);
	});

	it('no font means no drawtext at all', () => {
		const args = seekArgs('/in.mp4', plan(), 1, null, '/o/1.jpg');
		assert.equal(args[args.indexOf('-vf') + 1], 'scale=640:360');
	});

	it('never uses the fps filter, which relabels frames (V-R1)', () => {
		const all = [
			selectPassArgs('/i', plan(), 0, { font: FONT, startSec: 0 }, '/o'),
			selectPassArgs('/i', plan({ strategy: 'keyframes', keyframeIndices: [0] }), 0, null, '/o'),
			seekArgs('/i', plan(), 3, { font: FONT, startSec: 0 }, '/o'),
			composeArgs('/t_%03d.jpg', 3, '/o'),
			keyframeScanArgs('/i'),
		].flat();
		assert.ok(!all.some((arg) => /(^|[,'])fps=/.test(arg)), all.join(' '));
	});

	it('compose, scan, probe and subtitles', () => {
		assert.deepEqual(composeArgs('/t/tile_%03d.jpg', 2, '/o/img_%03d.jpg'), [
			'-hide_banner',
			'-nostats',
			'-y',
			'-framerate',
			'1',
			'-i',
			'/t/tile_%03d.jpg',
			'-vf',
			'tile=2x2',
			'-q:v',
			'3',
			'/o/img_%03d.jpg',
		]);
		assert.deepEqual(keyframeScanArgs('/i'), [
			'-hide_banner',
			'-nostats',
			'-skip_frame',
			'nokey',
			'-i',
			'/i',
			'-an',
			'-sn',
			'-dn',
			'-vf',
			'showinfo',
			'-f',
			'null',
			'-',
		]);
		assert.deepEqual(probeArgs('/i'), ['-hide_banner', '-i', '/i']);
		assert.deepEqual(subtitleArgs('/i', 1), [
			'-hide_banner',
			'-nostats',
			'-i',
			'/i',
			'-map',
			'0:s:1',
			'-f',
			'srt',
			'-',
		]);
	});

	it('label size follows the tile height, with a floor', () => {
		const vf = (h: number) =>
			seekArgs('/i', plan({ tileHeight: h }), 0, { font: FONT, startSec: 0 }, '/o').join(' ');
		assert.match(vf(720), /fontsize=56/);
		assert.match(vf(100), /fontsize=14/);
	});
});

describe('label helpers', () => {
	it('formats hh:mm:ss.mmm with drawtext-escaped colons', () => {
		assert.equal(escapedHms(0), '00\\:00\\:00.000');
		assert.equal(escapedHms(3725.5), '01\\:02\\:05.500');
	});

	it('only uses font paths that need no escaping', () => {
		assert.equal(isUsableFontPath('/usr/share/fonts/DejaVu Sans.ttf'), true);
		assert.equal(isUsableFontPath("/fonts/it's.ttf"), false);
		assert.equal(isUsableFontPath('C:/Windows/Fonts/arial.ttf'), false);
	});
});
