import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ffmpegCandidates, findFont, type BinaryDeps } from '../nodes/shared/video/binary';
import { extractFrames, type ExtractDeps, type ExtractSpec } from '../nodes/shared/video/extract';
import type { FfmpegRun } from '../nodes/shared/video/ffmpeg';

const fixture = (name: string) =>
	readFileSync(join(process.cwd(), 'tests', 'video-fixtures', name), 'utf8');

const ok = (over: Partial<FfmpegRun> = {}): FfmpegRun => ({
	code: 0,
	stdout: '',
	stderr: '',
	killed: false,
	...over,
});

type Call = { binary: string; args: string[] };

/**
 * A fake ffmpeg: answers by what the argv asks for, and "writes" the files a pass would, so the
 * extractor's bookkeeping runs as it does for real.
 */
function fakeDeps(
	answer: (args: string[], binary: string) => FfmpegRun | undefined = () => undefined,
	over: Partial<ExtractDeps> = {},
): { deps: ExtractDeps; calls: Call[]; files: Set<string> } {
	const calls: Call[] = [];
	const files = new Set<string>();
	let clock = 0;
	const deps: ExtractDeps = {
		run: async (binary, args) => {
			calls.push({ binary, args });
			const custom = answer(args, binary);
			if (custom) return custom;
			if (args.includes('-version'))
				return ok({ stdout: 'ffmpeg version N-49006-test-static https://x\n' });
			if (args.length === 3 && args[1] === '-i')
				return ok({ code: 1, stderr: fixture('probe-landscape.mp4.txt') });
			if (args.includes('nokey') && args.includes('null'))
				return ok({ stderr: fixture('keyframes-landscape.txt') });
			const out = args[args.length - 1];
			if (args.includes('-ss')) {
				files.add(out);
				return ok();
			}
			if (args.includes('srt')) return ok({ stdout: fixture('subtitles.srt') });
			// a select pass (or compose): two images
			files.add(out.replace('%03d', '001'));
			files.add(out.replace('%03d', '002'));
			return ok({ stderr: fixture('pass-decode.txt') });
		},
		candidates: () => ({ candidates: [{ path: '/bundled/ffmpeg', source: 'bundled' }], notes: [] }),
		font: () => '/fonts/Arial.ttf',
		mkdir: () => undefined,
		listDir: (dir) =>
			[...files].filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)),
		fileSize: (path) => (files.has(path) ? 1000 : 0),
		now: () => (clock += 10),
		...over,
	};
	return { deps, calls, files };
}

const spec = (over: Partial<ExtractSpec> = {}): ExtractSpec => ({
	sampling: {
		mode: 'frames',
		maxImages: 2,
		grid: 3,
		minIntervalSec: 1,
		startSec: null,
		endSec: null,
		framesLongEdge: 1280,
		mosaicLongEdge: 1920,
	},
	burnTimestamps: true,
	includeSubtitles: true,
	ffmpegPath: '',
	timeoutMs: 60_000,
	workDir: '/work',
	...over,
});

const INPUT = { path: '/work/input.mp4', fileName: 'rec.mp4' };

describe('extractFrames over a fake ffmpeg', () => {
	it('version, probe, keyframe scan, then one pass; times come from showinfo, not the plan', async () => {
		const { deps, calls } = fakeDeps();
		const result = await extractFrames(INPUT, spec(), deps);
		assert.ok('images' in result, JSON.stringify(result));
		assert.deepEqual(
			calls.map((c) => c.args.find((a) => ['-version', 'nokey', '-vf'].includes(a)) ?? 'probe'),
			['-version', 'probe', 'nokey', 'nokey'],
		);
		// 12 s, keyframes every 3 s, 2 frames at 6 s intervals: keyframe strategy.
		assert.equal(result.report.strategy, 'keyframes');
		assert.deepEqual(
			result.images.map((i) => i.timestamps),
			[[2.5], [7.267]],
		);
		assert.deepEqual(
			result.images.map((i) => i.path),
			['/work/images/img_001.jpg', '/work/images/img_002.jpg'],
		);
		assert.deepEqual(result.report.ffmpeg, { source: 'bundled', version: 'N-49006-test-static' });
		assert.equal(result.report.labels, 'burned');
		assert.deepEqual(result.report.notes, []);
		assert.equal(result.subtitles, null, 'the landscape fixture has no subtitle track');
	});

	it('falls back from a broken bundled binary to the PATH, and reports which ran', async () => {
		const { deps } = fakeDeps(
			(args, binary) =>
				binary === '/bundled/ffmpeg' ? ok({ code: null, spawnError: 'EACCES' }) : undefined,
			{
				candidates: () => ({
					candidates: [
						{ path: '/bundled/ffmpeg', source: 'bundled' },
						{ path: 'ffmpeg', source: 'path' },
					],
					notes: [],
				}),
			},
		);
		const result = await extractFrames(INPUT, spec(), deps);
		assert.ok('images' in result);
		assert.equal(result.report.ffmpeg.source, 'path');
	});

	it('no usable binary names every place it looked', async () => {
		const { deps } = fakeDeps(() => ok({ code: null, spawnError: 'ENOENT' }), {
			candidates: () => ({
				candidates: [{ path: 'ffmpeg', source: 'path' }],
				notes: [
					'bundled: none for freebsd-x64 (only linux-x64 and linux-arm64 are bundled; install ffmpeg on the PATH)',
				],
			}),
		});
		const result = await extractFrames(INPUT, spec(), deps);
		assert.ok('problem' in result);
		assert.equal(result.problem.message, 'No usable ffmpeg was found');
		assert.equal(
			result.problem.description,
			'Looked at: bundled: none for freebsd-x64 (only linux-x64 and linux-arm64 are bundled; install ffmpeg on the PATH); path (ffmpeg): not found. On Linux x64 or arm64, reinstall the package so its bundled ffmpeg is present; elsewhere install ffmpeg on the PATH (brew install ffmpeg, winget install ffmpeg) or set FFmpeg Path.',
		);
	});

	it('a codec the build cannot decode is named, with the way out', async () => {
		const { deps } = fakeDeps((args) =>
			args.includes('null')
				? ok({ code: 1, stderr: 'Decoder (codec av1) not found for input stream #0:0\n' })
				: undefined,
		);
		const result = await extractFrames(INPUT, spec(), deps);
		assert.ok('problem' in result);
		assert.equal(result.problem.message, 'ffmpeg cannot decode av1 video');
		assert.match(result.problem.description ?? '', /FFmpeg Path/);
	});

	it('a pass killed by the timeout is a timeout, naming the pass', async () => {
		const { deps } = fakeDeps((args) =>
			args.includes('-vf') && args.includes('-vsync')
				? ok({ code: null, killed: true })
				: undefined,
		);
		const result = await extractFrames(INPUT, spec({ timeoutMs: 300_000 }), deps);
		assert.ok('problem' in result);
		assert.equal(
			result.problem.message,
			'Extracting frames did not finish within 300s (the keyframes pass)',
		);
	});

	it('passes the time left, not the whole timeout, to each call', async () => {
		const timeouts: number[] = [];
		const base = fakeDeps();
		const deps: ExtractDeps = {
			...base.deps,
			run: async (binary, args, options) => {
				timeouts.push(options.timeoutMs);
				return base.deps.run(binary, args, options);
			},
		};
		await extractFrames(INPUT, spec({ timeoutMs: 1000 }), deps);
		assert.ok(timeouts.every((t, i) => i === 0 || t < timeouts[i - 1] || t === timeouts[i - 1]));
		assert.ok(timeouts[timeouts.length - 1] < 1000);
	});

	it('no font: frames still extracted, without labels, and the report says why', async () => {
		const { deps, calls } = fakeDeps(undefined, { font: () => null });
		const result = await extractFrames(INPUT, spec(), deps);
		assert.ok('images' in result);
		assert.equal(result.report.labels, 'none');
		assert.match(result.report.notes[0], /No TrueType font/);
		assert.ok(!calls.some((c) => c.args.some((a) => a.includes('drawtext'))));
	});

	it('Burn In Timestamps off: no labels and no note', async () => {
		const { deps } = fakeDeps();
		const result = await extractFrames(INPUT, spec({ burnTimestamps: false }), deps);
		assert.ok('images' in result);
		assert.equal(result.report.labels, 'none');
		assert.deepEqual(result.report.notes, []);
	});

	it('exports a text subtitle track; reports a bitmap one instead of skipping it silently', async () => {
		const text = fakeDeps((args) =>
			args.length === 3 ? ok({ code: 1, stderr: fixture('probe-subtitled.mp4.txt') }) : undefined,
		);
		const withText = await extractFrames(INPUT, spec(), text.deps);
		assert.ok('images' in withText);
		assert.deepEqual(withText.report.subtitles, { codec: 'mov_text', cues: 2 });
		assert.match(withText.subtitles?.text ?? '', /Hello from the subtitle track/);

		const bitmap = fakeDeps((args) =>
			args.length === 3
				? ok({
						code: 1,
						stderr: fixture('probe-subtitled.mp4.txt').replace(
							'Subtitle: mov_text',
							'Subtitle: hdmv_pgs_subtitle',
						),
					})
				: undefined,
		);
		const withBitmap = await extractFrames(INPUT, spec(), bitmap.deps);
		assert.ok('images' in withBitmap);
		assert.equal(withBitmap.subtitles, null);
		assert.match(withBitmap.report.notes[0], /hdmv_pgs_subtitle\) is an image format/);
	});

	it('seek: numbers the files written, skips a seek that wrote none, and says so', async () => {
		// Keyframes every 5 s over 30 s; 8 frames: seek.
		const keyframes = [0, 5, 10, 15, 20, 25, 30]
			.map((t, n) => `[Parsed_showinfo_0 @ 0x1] n:${n} pts:${t * 1000} pts_time:${t} pos:1`)
			.join('\n');
		const probe = fixture('probe-landscape.mp4.txt').replace('00:00:12.02', '00:00:30.00');
		let seeks = 0;
		const { deps, files } = fakeDeps((args) => {
			if (args.length === 3) return ok({ code: 1, stderr: probe });
			if (args.includes('null')) return ok({ stderr: keyframes });
			if (args.includes('-ss') && ++seeks === 8)
				return ok({ code: 1, stderr: 'Output file is empty' });
			return undefined;
		});
		const result = await extractFrames(
			INPUT,
			spec({ sampling: { ...spec().sampling, maxImages: 8 } }),
			deps,
		);
		assert.ok('images' in result, JSON.stringify(result));
		assert.equal(result.report.strategy, 'seek');
		assert.equal(result.images.length, 7);
		assert.ok(files.has('/work/images/img_007.jpg') && !files.has('/work/images/img_008.jpg'));
		assert.match(result.report.notes[0], /^1 of 8 seeks produced no frame/);
	});

	it('nothing written is a failure, not an empty success', async () => {
		const { deps } = fakeDeps(
			(args) => (args.includes('-vsync') ? ok({ stderr: '' }) : undefined),
			{
				listDir: () => [],
			},
		);
		const result = await extractFrames(INPUT, spec(), deps);
		assert.ok('problem' in result);
		assert.equal(result.problem.message, 'ffmpeg produced no frames from rec.mp4');
	});
});

describe('which ffmpeg, which font', () => {
	const deps = (over: Partial<BinaryDeps> = {}): BinaryDeps => ({
		platform: 'linux',
		arch: 'x64',
		resolve: (id) => `/nm/${id}`,
		exists: () => false,
		listDir: () => [],
		...over,
	});

	it('the bundled Linux binary first, then the PATH', () => {
		assert.deepEqual(ffmpegCandidates('', deps()).candidates, [
			{ path: '/nm/@ffmpeg-installer/linux-x64/ffmpeg', source: 'bundled' },
			{ path: 'ffmpeg', source: 'path' },
		]);
		assert.equal(
			ffmpegCandidates('', deps({ arch: 'arm64' })).candidates[0].path,
			'/nm/@ffmpeg-installer/linux-arm64/ffmpeg',
		);
	});

	it('bundles nothing outside Linux: the darwin-arm64 build is nonfree', () => {
		const result = ffmpegCandidates('', deps({ platform: 'darwin', arch: 'arm64' }));
		assert.deepEqual(result.candidates, [{ path: 'ffmpeg', source: 'path' }]);
		assert.deepEqual(result.notes, [
			'bundled: none for darwin-arm64 (only linux-x64 and linux-arm64 are bundled; install ffmpeg on the PATH)',
		]);
	});

	it('a Linux install without its optional package falls back to the PATH, saying why', () => {
		const result = ffmpegCandidates(
			'',
			deps({
				resolve: () => {
					throw new Error("Cannot find module '@ffmpeg-installer/linux-x64/package.json'");
				},
			}),
		);
		assert.deepEqual(result.candidates, [{ path: 'ffmpeg', source: 'path' }]);
		assert.deepEqual(result.notes, ['bundled: @ffmpeg-installer/linux-x64 is not installed']);
	});

	it('the package declares exactly the two Linux builds, as optional', () => {
		const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
		assert.deepEqual(Object.keys(pkg.optionalDependencies ?? {}).sort(), [
			'@ffmpeg-installer/linux-arm64',
			'@ffmpeg-installer/linux-x64',
		]);
		assert.ok(!('@ffmpeg-installer/ffmpeg' in (pkg.dependencies ?? {})));
	});

	it('a configured path is the only candidate', () => {
		assert.deepEqual(ffmpegCandidates('  /opt/ffmpeg ', deps()).candidates, [
			{ path: '/opt/ffmpeg', source: 'configured' },
		]);
	});

	it("finds n8n's Arial first, else the first .ttf under the font roots", () => {
		const arial = '/usr/share/fonts/truetype/msttcorefonts/Arial.ttf';
		assert.equal(findFont(deps({ exists: (p) => p === arial || p === '/usr/share/fonts' })), arial);
		const tree: Record<string, string[]> = {
			'/usr/share/fonts': ['Type1', 'truetype'],
			'/usr/share/fonts/Type1': ['a.pfb'],
			'/usr/share/fonts/truetype': ['liberation'],
			'/usr/share/fonts/truetype/liberation': ['LiberationSans.ttf'],
		};
		assert.equal(
			findFont(deps({ exists: (p) => p in tree, listDir: (p) => tree[p] ?? [] })),
			'/usr/share/fonts/truetype/liberation/LiberationSans.ttf',
		);
		assert.equal(findFont(deps()), null);
	});
});
