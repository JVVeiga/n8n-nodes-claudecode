import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Problem } from '../problem';
import { preview } from '../preview';
import {
	composeArgs,
	keyframeScanArgs,
	probeArgs,
	seekArgs,
	selectPassArgs,
	subtitleArgs,
	versionArgs,
	type LabelSpec,
} from './args';
import { ffmpegCandidates, findFont, type FfmpegCandidate } from './binary';
import { runFfmpeg, type FfmpegRun, type FfmpegRunner } from './ffmpeg';
import { planSampling } from './plan';
import { parseProbe } from './probe';
import { parseShowinfo } from './showinfo';
import { cleanSrt } from './subtitles';
import type {
	ExtractedImage,
	ExtractResult,
	SamplingPlan,
	SamplingSpec,
	Subtitles,
	VideoInfo,
} from './types';

/** probe -> keyframes -> plan -> passes -> files and a report. Every ffmpeg call goes through `deps.run`. */

export type ExtractSpec = {
	sampling: SamplingSpec;
	burnTimestamps: boolean;
	includeSubtitles: boolean;
	/** Empty: the bundled binary, then `ffmpeg` on the PATH. */
	ffmpegPath: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** A directory this call owns; the caller removes it. */
	workDir: string;
};

export type ExtractDeps = {
	run: FfmpegRunner;
	candidates: (configured: string) => { candidates: FfmpegCandidate[]; notes: string[] };
	font: () => string | null;
	mkdir: (path: string) => void;
	listDir: (path: string) => string[];
	/** 0 when absent. */
	fileSize: (path: string) => number;
	now: () => number;
};

export const defaultExtractDeps: ExtractDeps = {
	run: runFfmpeg,
	candidates: (configured) => ffmpegCandidates(configured),
	font: () => findFont(),
	mkdir: (path) => mkdirSync(path, { recursive: true }),
	listDir: (path) => readdirSync(path),
	fileSize: (path) => {
		try {
			return statSync(path).size;
		} catch {
			return 0;
		}
	},
	now: () => Date.now(),
};

type Outcome<T> = T | { problem: Problem };

const ms3 = (seconds: number): number => Math.round(seconds * 1000) / 1000;

const lastLines = (stderr: string, count = 3): string =>
	preview(
		stderr
			.trim()
			.split('\n')
			.filter((line) => line.trim() && !/^\s*(Metadata|Side data|handler_name|encoder)/.test(line))
			.slice(-count)
			.join(' | '),
		400,
	);

function failureOf(pass: string, run: FfmpegRun, timeoutSec: number): Problem {
	if (run.killed) {
		return {
			message: `Extracting frames did not finish within ${timeoutSec}s (${pass})`,
			description:
				'Raise Timeout, narrow Start Time / End Time, or lower Max Images. A long video with few keyframes needs a full decode, which takes about 4 minutes per hour of 1080p on 2 CPUs.',
		};
	}
	const decoder = /Decoder \(codec (\w+)\) not found/.exec(run.stderr);
	if (decoder) {
		return {
			message: `ffmpeg cannot decode ${decoder[1]} video`,
			description:
				'The bundled ffmpeg predates this codec. Set FFmpeg Path to a newer ffmpeg build, or convert the video to H.264 first.',
		};
	}
	return {
		message: `ffmpeg failed during ${pass} (exit ${run.code ?? run.spawnError ?? 'unknown'})`,
		description: lastLines(run.stderr) || 'ffmpeg printed nothing.',
	};
}

async function pickBinary(
	spec: ExtractSpec,
	deps: ExtractDeps,
	remaining: () => number,
): Promise<Outcome<{ candidate: FfmpegCandidate; version: string }>> {
	const { candidates, notes } = deps.candidates(spec.ffmpegPath);
	const tried = [...notes];
	for (const candidate of candidates) {
		const run = await deps.run(candidate.path, versionArgs(), {
			timeoutMs: Math.min(remaining(), 15_000),
			signal: spec.signal,
		});
		if (run.code === 0) {
			const version = /ffmpeg version (\S+)/.exec(run.stdout)?.[1] ?? 'unknown';
			return { candidate, version };
		}
		const why =
			run.spawnError === 'ENOENT'
				? 'not found'
				: run.spawnError === 'EACCES'
					? 'not executable'
					: preview(run.stderr.trim().split('\n')[0] ?? `exit ${run.code}`, 120);
		tried.push(`${candidate.source} (${candidate.path}): ${why}`);
	}
	return {
		problem: {
			message: 'No usable ffmpeg was found',
			description: `Looked at: ${tried.join('; ')}. Reinstall the package so its bundled ffmpeg for this platform is present, install ffmpeg on the PATH, or set FFmpeg Path.`,
		},
	};
}

/** Group per-frame times into one list per output image. */
function groupTimes(times: number[], files: string[], plan: SamplingPlan): ExtractedImage[] {
	const perImage = plan.grid * plan.grid;
	return files.map((path, i) => ({
		path,
		timestamps: times.slice(i * perImage, (i + 1) * perImage),
	}));
}

async function extractImages(
	input: string,
	info: VideoInfo,
	plan: SamplingPlan,
	label: LabelSpec,
	ctx: { binary: string; spec: ExtractSpec; deps: ExtractDeps; remaining: () => number },
	notes: string[],
): Promise<Outcome<{ images: ExtractedImage[] }>> {
	const { binary, spec, deps, remaining } = ctx;
	const timeoutSec = Math.round(spec.timeoutMs / 1000);
	const outDir = join(spec.workDir, 'images');
	deps.mkdir(outDir);
	const outPattern = join(outDir, 'img_%03d.jpg');
	const outputs = () =>
		deps
			.listDir(outDir)
			.filter((name) => /^img_\d{3,}\.jpg$/.test(name))
			.sort()
			.map((name) => join(outDir, name));

	if (plan.strategy !== 'seek') {
		const run = await deps.run(
			binary,
			selectPassArgs(input, plan, info.startSec, label, outPattern),
			{ timeoutMs: remaining(), signal: spec.signal },
		);
		if (run.code !== 0) return { problem: failureOf(`the ${plan.strategy} pass`, run, timeoutSec) };
		const times = parseShowinfo(run.stderr).map((f) => ms3(f.ptsTime - info.startSec));
		return { images: groupTimes(times, outputs(), plan) };
	}

	// seek: one accurate seek per target. A target past the last decodable frame writes nothing,
	// so numbering follows what was written: the image2 reader stops at the first gap.
	const tileDir = join(spec.workDir, 'tiles');
	if (plan.mode === 'mosaic') deps.mkdir(tileDir);
	const times: number[] = [];
	let lastFailure: FfmpegRun | null = null;
	for (const target of plan.targets) {
		const name = `${plan.mode === 'mosaic' ? 'tile' : 'img'}_${String(times.length + 1).padStart(3, '0')}.jpg`;
		const file = join(plan.mode === 'mosaic' ? tileDir : outDir, name);
		const run = await deps.run(binary, seekArgs(input, plan, target, label, file), {
			timeoutMs: remaining(),
			signal: spec.signal,
		});
		if (run.killed) return { problem: failureOf('a seek', run, timeoutSec) };
		if (run.code === 0 && deps.fileSize(file) > 0) times.push(ms3(target));
		else if (run.code !== 0) lastFailure = run;
	}
	if (times.length === 0 && lastFailure) {
		return { problem: failureOf('seeking', lastFailure, timeoutSec) };
	}
	const skipped = plan.targets.length - times.length;
	if (skipped > 0) {
		notes.push(
			`${skipped} of ${plan.targets.length} seeks produced no frame, usually because they fell past the last decodable frame.`,
		);
	}
	if (plan.mode === 'mosaic' && times.length > 0) {
		const run = await deps.run(
			binary,
			composeArgs(join(tileDir, 'tile_%03d.jpg'), plan.grid, outPattern),
			{ timeoutMs: remaining(), signal: spec.signal },
		);
		if (run.code !== 0) return { problem: failureOf('composing the mosaics', run, timeoutSec) };
	}
	return { images: groupTimes(times, outputs(), plan) };
}

async function extractSubtitles(
	input: string,
	info: VideoInfo,
	ctx: { binary: string; spec: ExtractSpec; deps: ExtractDeps; remaining: () => number },
	notes: string[],
): Promise<Subtitles | null> {
	if (!ctx.spec.includeSubtitles || info.subtitles.length === 0) return null;
	const track = info.subtitles.find((s) => s.textual);
	if (!track) {
		notes.push(
			`The subtitle track (${info.subtitles[0].codec}) is an image format, so it was not exported as text.`,
		);
		return null;
	}
	const run = await ctx.deps.run(ctx.binary, subtitleArgs(input, track.index), {
		timeoutMs: ctx.remaining(),
		signal: ctx.spec.signal,
	});
	const { text, cues } = run.code === 0 ? cleanSrt(run.stdout) : { text: '', cues: 0 };
	if (cues === 0) {
		notes.push(
			`The ${track.codec} subtitle track could not be exported${run.code === 0 ? ' (no cues)' : ''}.`,
		);
		return null;
	}
	return { text, cues, codec: track.codec };
}

export async function extractFrames(
	input: { path: string; fileName: string },
	spec: ExtractSpec,
	deps: ExtractDeps = defaultExtractDeps,
): Promise<Outcome<ExtractResult>> {
	const started = deps.now();
	const remaining = () => Math.max(1, spec.timeoutMs - (deps.now() - started));
	const timeoutSec = Math.round(spec.timeoutMs / 1000);

	const picked = await pickBinary(spec, deps, remaining);
	if ('problem' in picked) return picked;
	const binary = picked.candidate.path;

	const probed = await deps.run(binary, probeArgs(input.path), {
		timeoutMs: remaining(),
		signal: spec.signal,
	});
	if (probed.killed) return { problem: failureOf('the probe', probed, timeoutSec) };
	const parsed = parseProbe(probed.stderr, input.fileName);
	if ('problem' in parsed) return parsed;
	const { info } = parsed;

	const scan = await deps.run(binary, keyframeScanArgs(input.path), {
		timeoutMs: remaining(),
		signal: spec.signal,
	});
	if (scan.code !== 0) return { problem: failureOf('the keyframe scan', scan, timeoutSec) };
	const keyframes = parseShowinfo(scan.stderr).map((f) => f.ptsTime - info.startSec);

	const planned = planSampling(info, keyframes, spec.sampling);
	if ('problem' in planned) return planned;
	const { plan } = planned;

	const notes: string[] = [];
	let label: LabelSpec = null;
	if (spec.burnTimestamps) {
		const font = deps.font();
		if (font) label = { font, startSec: info.startSec };
		else
			notes.push(
				'No TrueType font was found, so the timestamps are not drawn on the images; they are in the file names and the JSON.',
			);
	}

	const ctx = { binary, spec, deps, remaining };
	const extracted = await extractImages(input.path, info, plan, label, ctx, notes);
	if ('problem' in extracted) return extracted;
	if (extracted.images.length === 0) {
		return {
			problem: {
				message: `ffmpeg produced no frames from ${input.fileName}`,
				description: `Sampling ${plan.fromSec.toFixed(1)}s–${plan.toSec.toFixed(1)}s with the ${plan.strategy} strategy yielded nothing. Check Start Time / End Time against the video's length.`,
			},
		};
	}
	const subtitles = await extractSubtitles(input.path, info, ctx, notes);
	const tiles = extracted.images.reduce((sum, image) => sum + image.timestamps.length, 0);

	return {
		images: extracted.images,
		subtitles,
		report: {
			video: {
				durationSec: ms3(plan.durationSec),
				durationEstimated: plan.durationEstimated,
				width: info.width,
				height: info.height,
				codec: info.codec,
				fps: info.fps,
			},
			mode: plan.mode,
			strategy: plan.strategy,
			grid: plan.grid,
			coverage: {
				fromSec: ms3(plan.fromSec),
				toSec: ms3(plan.toSec),
				tiles,
				intervalSec: ms3(plan.intervalSec),
			},
			labels: label ? 'burned' : 'none',
			subtitles: subtitles ? { codec: subtitles.codec, cues: subtitles.cues } : null,
			notes,
			ffmpeg: { source: picked.candidate.source, version: picked.version },
			elapsedMs: deps.now() - started,
		},
	};
}
