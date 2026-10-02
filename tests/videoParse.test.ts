import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseProbe } from '../nodes/shared/video/probe';
import { parseShowinfo } from '../nodes/shared/video/showinfo';
import { cleanSrt } from '../nodes/shared/video/subtitles';

// Real stderr from the bundled ffmpeg in n8n's image (spike S-5).
const fixture = (name: string) =>
	readFileSync(join(process.cwd(), 'tests', 'video-fixtures', name), 'utf8');
const probe = (name: string) => parseProbe(fixture(`probe-${name}.txt`), name);

describe('video probe', () => {
	it('reads an H.264 landscape MP4', () => {
		const result = probe('landscape.mp4');
		assert.ok('info' in result);
		assert.deepEqual(result.info, {
			container: 'mov,mp4,m4a,3gp,3g2,mj2',
			durationSec: 12.02,
			startSec: 0,
			codec: 'h264',
			width: 1280,
			height: 720,
			rotation: 0,
			fps: 30,
			hasAudio: true,
			subtitles: [],
		});
	});

	it('swaps the geometry of a stream displayed rotated', () => {
		const result = probe('rotated.mp4');
		assert.ok('info' in result);
		assert.equal(result.info.rotation, 90);
		assert.deepEqual([result.info.width, result.info.height], [720, 1280]);
	});

	it('lists a text subtitle track with its -map ordinal', () => {
		const result = probe('subtitled.mp4');
		assert.ok('info' in result);
		assert.deepEqual(result.info.subtitles, [{ index: 0, codec: 'mov_text', textual: true }]);
	});

	it('reports an unknown duration as null', () => {
		const result = probe('piped.mkv');
		assert.ok('info' in result);
		assert.equal(result.info.durationSec, null);
		assert.equal(result.info.container, 'matroska,webm');
	});

	it('reads VP9 in WebM', () => {
		const result = probe('clip.webm');
		assert.ok('info' in result);
		assert.equal(result.info.codec, 'vp9');
		assert.equal(result.info.fps, 25);
		assert.equal(result.info.hasAudio, false);
	});

	it('refuses audio only, saying so', () => {
		const result = probe('audio-only.m4a');
		assert.ok('problem' in result);
		assert.equal(result.problem.message, 'audio-only.m4a has no video stream');
		assert.match(result.problem.description ?? '', /audio only/);
	});

	it('refuses a file ffmpeg cannot open, with its reason', () => {
		const result = probe('garbage.mp4');
		assert.ok('problem' in result);
		assert.equal(
			result.problem.message,
			'garbage.mp4 could not be read as a video: Invalid data found when processing input',
		);
	});

	it('does not count cover art as footage', () => {
		const stderr = [
			"Input #0, mp3, from 'song.mp3':",
			'  Duration: 00:03:00.00, start: 0.025057, bitrate: 320 kb/s',
			'    Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s',
			'    Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 500x500, 90k tbr, 90k tbn (attached pic)',
		].join('\n');
		const result = parseProbe(stderr, 'song.mp3');
		assert.ok('problem' in result);
		assert.equal(result.problem.message, 'song.mp3 has no video stream');
	});

	it('keeps a non-zero container start', () => {
		const stderr = [
			"Input #0, mpegts, from 'cam.ts':",
			'  Duration: 00:00:10.00, start: 1.400000, bitrate: 900 kb/s',
			'    Stream #0:0[0x100]: Video: h264 (Main) ([27][0][0][0] / 0x001B), yuv420p, 640x480, 25 fps, 25 tbr, 90k tbn',
		].join('\n');
		const result = parseProbe(stderr, 'cam.ts');
		assert.ok('info' in result);
		assert.equal(result.info.startSec, 1.4);
		assert.deepEqual([result.info.width, result.info.height], [640, 480]);
	});
});

describe('showinfo', () => {
	it('reads every keyframe of a keyframe-only scan', () => {
		assert.deepEqual(parseShowinfo(fixture('keyframes-landscape.txt')), [
			{ n: 0, ptsTime: 0 },
			{ n: 1, ptsTime: 3 },
			{ n: 2, ptsTime: 6 },
			{ n: 3, ptsTime: 9 },
		]);
	});

	it('reads the real times of the frames a select pass kept', () => {
		assert.deepEqual(
			parseShowinfo(fixture('pass-decode.txt')).map((f) => f.ptsTime),
			[2.5, 7.26667],
		);
	});

	it('ignores the other lines a pass prints', () => {
		assert.equal(parseShowinfo(fixture('pass-compose.txt')).length, 0);
	});
});

describe('subtitles', () => {
	it('strips the font tags ffmpeg adds to mov_text, and counts cues', () => {
		const { text, cues } = cleanSrt(fixture('subtitles.srt'));
		assert.equal(cues, 2);
		assert.equal(
			text,
			'1\n00:00:01,000 --> 00:00:03,000\nHello from the subtitle track\n\n2\n00:00:05,000 --> 00:00:07,500\nSecond cue\n',
		);
	});

	it('strips ASS override blocks and CRLF', () => {
		const { text, cues } = cleanSrt('1\r\n00:00:01,000 --> 00:00:02,000\r\n{\\an8}<i>Top</i>\r\n');
		assert.equal(text, '1\n00:00:01,000 --> 00:00:02,000\nTop\n');
		assert.equal(cues, 1);
	});

	it('an empty export has no cues', () => {
		assert.deepEqual(cleanSrt('\n'), { text: '', cues: 0 });
	});
});
