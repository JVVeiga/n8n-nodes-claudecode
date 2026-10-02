import type { SamplingMode } from '../../shared/video/types';
import type { VideoAttachmentSpec } from './types';

/**
 * The four video options -> VideoAttachmentSpec, for the Claude Code node and the Agent alike.
 *
 * `auto` resolves against the node version, as Attach All's does: n8n writes schema defaults into
 * stored workflows, so only a version can tell a new node from one saved before video support.
 */

export type VideoSelection = 'auto' | 'frames' | 'stage';

export type VideoOptions = {
	videoAttachments?: VideoSelection;
	videoSampling?: SamplingMode;
	videoMaxImages?: number;
	maxVideoMb?: number;
};

export const VIDEO_DEFAULTS = { mode: 'auto', maxImages: 15, maxVideoMb: 2048 } as const;

const MODES: SamplingMode[] = ['auto', 'frames', 'mosaic'];

export function readVideoSpec(
	options: VideoOptions,
	framesByDefault: boolean,
): VideoAttachmentSpec {
	const selection = options.videoAttachments ?? 'auto';
	const handling =
		selection === 'frames' || selection === 'stage'
			? selection
			: framesByDefault
				? 'frames'
				: 'stage';
	const mode = options.videoSampling ?? VIDEO_DEFAULTS.mode;
	const maxImages = Number(options.videoMaxImages);
	const maxVideoMb = Number(options.maxVideoMb);
	return {
		handling,
		mode: MODES.includes(mode) ? mode : VIDEO_DEFAULTS.mode,
		maxImages:
			Number.isFinite(maxImages) && maxImages >= 1
				? Math.round(maxImages)
				: VIDEO_DEFAULTS.maxImages,
		maxVideoMb:
			Number.isFinite(maxVideoMb) && maxVideoMb >= 1 ? maxVideoMb : VIDEO_DEFAULTS.maxVideoMb,
	};
}
