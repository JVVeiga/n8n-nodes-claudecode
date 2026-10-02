import type { SamplingPlan } from './types';

/**
 * Plans -> ffmpeg argv. No `fps=` filter anywhere: it relabels frames, and a label must be the
 * frame's own time.
 */

const BASE = ['-hide_banner', '-nostats', '-y'];
const NO_OTHER_STREAMS = ['-an', '-sn', '-dn'];
const JPEG = ['-q:v', '3'];

export type LabelSpec = { font: string; startSec: number } | null;

/** A font path is only ever quoted, so one that would need escaping is not used at all. */
export const isUsableFontPath = (path: string): boolean => /^[\w./ -]+$/.test(path);

const fontSizeFor = (tileHeight: number): number => Math.max(14, Math.round(tileHeight * 0.078));

const drawtext = (font: string, text: string, tileHeight: number): string =>
	`drawtext=fontfile='${font}':text='${text}':fontsize=${fontSizeFor(tileHeight)}` +
	':fontcolor=yellow:box=1:boxcolor=black@0.7:x=8:y=8';

/** `00\:01\:05.250`: drawtext's own escaping of the colons, inside the quoted text. */
export function escapedHms(seconds: number): string {
	const ms = Math.round(seconds * 1000);
	const h = Math.floor(ms / 3_600_000);
	const m = Math.floor((ms % 3_600_000) / 60_000);
	const s = (ms % 60_000) / 1000;
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${pad(h)}\\:${pad(m)}\\:${s.toFixed(3).padStart(6, '0')}`;
}

const scale = (plan: SamplingPlan): string => `scale=${plan.tileWidth}:${plan.tileHeight}`;

/** The pts label, offset so a file whose container starts late still reads from 00:00:00. */
function ptsLabel(label: NonNullable<LabelSpec>, plan: SamplingPlan): string {
	const offset = label.startSec ? `\\:${(-label.startSec).toFixed(6)}` : '';
	return drawtext(label.font, `%{pts\\:hms${offset}}`, plan.tileHeight);
}

const t = (seconds: number): string => seconds.toFixed(3);

export const probeArgs = (input: string): string[] => ['-hide_banner', '-i', input];

export const versionArgs = (): string[] => ['-hide_banner', '-version'];

/** Every keyframe's time, without decoding anything else (S-2c: under a second for 10 min). */
export const keyframeScanArgs = (input: string): string[] => [
	'-hide_banner',
	'-nostats',
	'-skip_frame',
	'nokey',
	'-i',
	input,
	...NO_OTHER_STREAMS,
	'-vf',
	'showinfo',
	'-f',
	'null',
	'-',
];

/** `keyframes` and `decode`: `select` keeps the source pts, so `%{pts}` is the real time. */
export function selectPassArgs(
	input: string,
	plan: SamplingPlan,
	startSec: number,
	label: LabelSpec,
	outPattern: string,
): string[] {
	const select =
		plan.strategy === 'keyframes'
			? plan.keyframeIndices.map((n) => `eq(n\\,${n})`).join('+')
			: plan.targets
					.map((target) => {
						const at = t(target + startSec);
						return `gte(t\\,${at})*lt(prev_t\\,${at})`;
					})
					.join('+');
	const chain = [
		`select='${select}'`,
		scale(plan),
		...(label ? [ptsLabel(label, plan)] : []),
		'showinfo',
		...(plan.mode === 'mosaic' ? [`tile=${plan.grid}x${plan.grid}`] : []),
	];
	return [
		...BASE,
		...(plan.strategy === 'keyframes' ? ['-skip_frame', 'nokey'] : []),
		'-i',
		input,
		...NO_OTHER_STREAMS,
		'-vf',
		chain.join(','),
		'-vsync',
		'vfr',
		...JPEG,
		outPattern,
	];
}

/** One accurate seek (`-ss` before `-i`, relative to the container start). Labelled literally. */
export function seekArgs(
	input: string,
	plan: SamplingPlan,
	target: number,
	label: LabelSpec,
	outFile: string,
): string[] {
	const chain = [
		scale(plan),
		...(label ? [drawtext(label.font, escapedHms(target), plan.tileHeight)] : []),
	];
	return [
		...BASE,
		'-ss',
		t(target),
		'-i',
		input,
		...NO_OTHER_STREAMS,
		'-frames:v',
		'1',
		'-vf',
		chain.join(','),
		...JPEG,
		outFile,
	];
}

/** Seek tiles -> mosaics. A short last mosaic is padded with black, never stretched. */
export const composeArgs = (tilePattern: string, grid: number, outPattern: string): string[] => [
	...BASE,
	'-framerate',
	'1',
	'-i',
	tilePattern,
	'-vf',
	`tile=${grid}x${grid}`,
	...JPEG,
	outPattern,
];

export const subtitleArgs = (input: string, index: number): string[] => [
	'-hide_banner',
	'-nostats',
	'-i',
	input,
	'-map',
	`0:s:${index}`,
	'-f',
	'srt',
	'-',
];
