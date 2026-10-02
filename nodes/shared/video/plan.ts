import type { Problem } from '../problem';
import type { SamplingPlan, SamplingSpec, Strategy, VideoInfo } from './types';

/** The sampling policy, pure: what to extract and how, from probed facts. See design.md. */

/** `auto` sends single frames while each would cover at most this many seconds. */
export const AUTO_FRAMES_MAX_SLOT_SEC = 5;

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Fit the video's display aspect into a box whose long edge is `longEdge`, never upscaling. */
export function fitSize(width: number, height: number, longEdge: number): [number, number] {
	const scale = Math.min(1, longEdge / Math.max(width, height));
	return [even(width * scale), even(height * scale)];
}

/** `decodeSec`: what one full pass decodes, the whole file (the pass does not seek to the range). */
function pickStrategy(
	gaps: number[],
	intervalSec: number,
	targets: number,
	decodeSec: number,
): Strategy {
	if (gaps.length === 0) return 'decode';
	const gop = median(gaps);
	if (gop <= intervalSec) return 'keyframes';
	// A seek decodes from the previous keyframe, half a GOP per target on average (S-2b: 180
	// seeks on an 8.3 s GOP cost what decoding 610 s does). Past that, one full pass is cheaper.
	return (targets * gop) / 2 <= decodeSec ? 'seek' : 'decode';
}

/** The keyframe nearest each target, once each, in time order. */
function nearestKeyframes(keyframes: number[], targets: number[]): number[] {
	const chosen = new Set<number>();
	for (const target of targets) {
		let best = 0;
		for (let i = 1; i < keyframes.length; i++) {
			if (Math.abs(keyframes[i] - target) < Math.abs(keyframes[best] - target)) best = i;
		}
		chosen.add(best);
	}
	return [...chosen].sort((a, b) => a - b);
}

/**
 * @param keyframes keyframe times in seconds from the start of the video (start already
 *   subtracted), in order — the `n` of each is its position in this array.
 */
export function planSampling(
	info: VideoInfo,
	keyframes: number[],
	spec: SamplingSpec,
): { plan: SamplingPlan } | { problem: Problem } {
	let duration = info.durationSec;
	let durationEstimated = false;
	if (duration === null) {
		if (keyframes.length === 0) {
			return { problem: { message: 'The video has no readable frames' } };
		}
		const gaps = keyframes.slice(1).map((t, i) => t - keyframes[i]);
		duration = keyframes[keyframes.length - 1] + (gaps.length ? median(gaps) : 0);
		durationEstimated = true;
	}

	const fromSec = Math.min(Math.max(spec.startSec ?? 0, 0), duration);
	const toSec = Math.min(Math.max(spec.endSec ?? duration, 0), duration);
	const span = toSec - fromSec;
	if (span <= 0) {
		return {
			problem: {
				message: `Nothing to extract between ${fromSec}s and ${toSec}s`,
				description: `The video is ${duration.toFixed(1)}s long. Start Time must be before End Time, and both inside the video.`,
			},
		};
	}

	const mode =
		spec.mode === 'auto'
			? span <= spec.maxImages * AUTO_FRAMES_MAX_SLOT_SEC
				? 'frames'
				: 'mosaic'
			: spec.mode;
	const grid = mode === 'mosaic' ? spec.grid : 1;
	const capacity = spec.maxImages * grid * grid;
	const count = Math.max(1, Math.min(capacity, Math.floor(span / spec.minIntervalSec)));
	const intervalSec = span / count;
	// The middle of each slot: the first and last moments are often black frames or credits.
	const targets = Array.from({ length: count }, (_, i) => fromSec + (i + 0.5) * intervalSec);

	const inRange = keyframes.filter((t) => t >= fromSec - intervalSec && t <= toSec + intervalSec);
	const gaps = inRange.slice(1).map((t, i) => t - inRange[i]);
	const strategy = pickStrategy(gaps, intervalSec, count, duration);
	const keyframeIndices = strategy === 'keyframes' ? nearestKeyframes(keyframes, targets) : [];
	const tiles = strategy === 'keyframes' ? keyframeIndices.length : count;

	const [tileWidth, tileHeight] =
		mode === 'mosaic'
			? fitSize(info.width, info.height, spec.mosaicLongEdge / grid)
			: fitSize(info.width, info.height, spec.framesLongEdge);

	return {
		plan: {
			mode,
			grid,
			strategy,
			targets,
			keyframeIndices,
			intervalSec,
			fromSec,
			toSec,
			tileWidth,
			tileHeight,
			imageCount: Math.ceil(tiles / (grid * grid)),
			durationSec: duration,
			durationEstimated,
		},
	};
}
