/** Plain data for video extraction; only `ffmpeg.ts` runs anything. */

export type VideoInfo = {
	/** Container as ffmpeg names it, e.g. `mov,mp4,m4a,3gp,3g2,mj2`. */
	container: string;
	/** Null when the header carries none (matroska written to a pipe, some fragmented MP4). */
	durationSec: number | null;
	/** The container's start time. Frame pts are absolute; every reported time subtracts this. */
	startSec: number;
	codec: string;
	/** Display geometry: rotation from the display matrix is already applied. */
	width: number;
	height: number;
	rotation: number;
	fps: number | null;
	hasAudio: boolean;
	/** Subtitle streams in input order; `index` is the n in `-map 0:s:n`. */
	subtitles: { index: number; codec: string; textual: boolean }[];
};

export type SamplingMode = 'auto' | 'frames' | 'mosaic';

export type SamplingSpec = {
	mode: SamplingMode;
	/** Output images, not tiles. */
	maxImages: number;
	/** A mosaic is grid × grid tiles. */
	grid: number;
	minIntervalSec: number;
	/** Null means the start or the end of the video. */
	startSec: number | null;
	endSec: number | null;
	framesLongEdge: number;
	mosaicLongEdge: number;
};

/**
 * How frames are pulled, chosen from probed facts (spikes S-2b/S-2c):
 * - `keyframes`: decode keyframes only; near-free, as dense as the keyframes are.
 * - `seek`: one accurate seek per target; cost grows with targets × GOP.
 * - `decode`: one full pass; cost grows with duration.
 */
export type Strategy = 'keyframes' | 'seek' | 'decode';

export type SamplingPlan = {
	mode: 'frames' | 'mosaic';
	/** 1 for frames. */
	grid: number;
	strategy: Strategy;
	/** Seconds from the start of the video (container start already subtracted). */
	targets: number[];
	/** For `keyframes`: the keyframe ordinals (`n` in the keyframe-only stream) to keep. */
	keyframeIndices: number[];
	intervalSec: number;
	fromSec: number;
	toSec: number;
	/** The size of one frame, or of one tile of a mosaic. Even numbers. */
	tileWidth: number;
	tileHeight: number;
	imageCount: number;
	durationSec: number;
	/** True when the duration was estimated from the last keyframe, not read from the header. */
	durationEstimated: boolean;
};

export type ExtractedImage = {
	/** Absolute path in the work directory. */
	path: string;
	/** Seconds from the start of the video, read from the frames themselves (one per tile). */
	timestamps: number[];
};

export type FfmpegSource = 'configured' | 'bundled' | 'path';

export type VideoFramesReport = {
	video: {
		durationSec: number;
		durationEstimated: boolean;
		width: number;
		height: number;
		codec: string;
		fps: number | null;
	};
	mode: 'frames' | 'mosaic';
	strategy: Strategy;
	grid: number;
	coverage: { fromSec: number; toSec: number; tiles: number; intervalSec: number };
	labels: 'burned' | 'none';
	subtitles: { codec: string; cues: number } | null;
	/** What was asked for and not delivered (no font for labels, a bitmap subtitle track...). */
	notes: string[];
	ffmpeg: { source: FfmpegSource; version: string };
	elapsedMs: number;
};

export type Subtitles = { text: string; cues: number; codec: string };

export type ExtractResult = {
	images: ExtractedImage[];
	subtitles: Subtitles | null;
	report: VideoFramesReport;
};
