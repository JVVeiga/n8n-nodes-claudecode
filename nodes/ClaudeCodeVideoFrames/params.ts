import type { IExecuteFunctions } from 'n8n-workflow';
import type { SamplingMode, SamplingSpec } from '../shared/video/types';

export type VideoFramesParams = {
	binaryProperty: string;
	sampling: SamplingSpec;
	burnTimestamps: boolean;
	includeSubtitles: boolean;
	keepInputBinary: boolean;
	maxVideoMb: number;
	outputPrefix: string;
	ffmpegPath: string;
	timeoutSec: number;
};

export type VideoFramesReadContext = Pick<IExecuteFunctions, 'getNodeParameter'>;

/** Frames ≈ 1.2k tokens each; a mosaic stays ≤ 2000 px so it is valid in a many-image request. */
export const FRAMES_LONG_EDGE = 1280;
export const MOSAIC_LONG_EDGE = 1920;

const MODES: SamplingMode[] = ['auto', 'frames', 'mosaic'];

export function readVideoFramesParams(
	ctx: VideoFramesReadContext,
	itemIndex: number,
): VideoFramesParams {
	const options = (ctx.getNodeParameter('options', itemIndex, {}) ?? {}) as Record<string, unknown>;
	const num = (value: unknown, fallback: number): number => {
		const n = Number(value);
		return value === undefined || value === null || value === '' || !Number.isFinite(n)
			? fallback
			: n;
	};
	const bool = (value: unknown, fallback: boolean): boolean =>
		typeof value === 'boolean' ? value : fallback;
	const mode = String(ctx.getNodeParameter('mode', itemIndex, 'auto'));
	const startSec = num(options.startSec, 0);
	const endSec = num(options.endSec, 0);

	return {
		binaryProperty:
			String(ctx.getNodeParameter('binaryProperty', itemIndex, 'data') ?? '').trim() || 'data',
		sampling: {
			mode: MODES.includes(mode as SamplingMode) ? (mode as SamplingMode) : 'auto',
			maxImages: Math.max(1, Math.round(num(ctx.getNodeParameter('maxImages', itemIndex, 20), 20))),
			grid: Math.min(4, Math.max(2, Math.round(num(options.grid, 3)))),
			minIntervalSec: Math.max(0.1, num(options.minIntervalSec, 1)),
			// 0 is the field's empty state, so it means "the start" / "the end".
			startSec: startSec > 0 ? startSec : null,
			endSec: endSec > 0 ? endSec : null,
			framesLongEdge: FRAMES_LONG_EDGE,
			mosaicLongEdge: MOSAIC_LONG_EDGE,
		},
		burnTimestamps: bool(options.burnTimestamps, true),
		includeSubtitles: bool(options.includeSubtitles, true),
		keepInputBinary: bool(options.keepInputBinary, false),
		maxVideoMb: Math.max(1, num(options.maxVideoMb, 2048)),
		outputPrefix: String(options.outputPrefix ?? 'frame').trim() || 'frame',
		ffmpegPath: String(options.ffmpegPath ?? '').trim(),
		timeoutSec: Math.max(5, num(options.timeoutSec, 300)),
	};
}
