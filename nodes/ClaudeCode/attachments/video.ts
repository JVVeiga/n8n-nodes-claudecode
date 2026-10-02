import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Problem } from '../../shared/problem';
import { writeBinaryFile, type BinaryFileContext } from '../../shared/video/binaryFile';
import { extractFrames } from '../../shared/video/extract';
import { clock, promptHint } from '../../shared/video/hint';
import type { ExtractResult } from '../../shared/video/types';
import type { AttachmentSpec, VideoAttachment, VideoDiagnostics } from './types';

/**
 * Video attachments -> image blocks with their times, through the same core as the Video Frames
 * node. The work directory is gone before the model runs: the frames travel as base64.
 */

/** Past 20 image blocks the API shrinks every image, which turns a user's large screenshot into a 400. */
export const MAX_IMAGES_PER_REQUEST = 20;

export const FRAMES_LONG_EDGE = 1280;
export const MOSAIC_LONG_EDGE = 1920;

export type VideoDeps = {
	extract: typeof extractFrames;
	makeWorkDir: () => string;
	removeWorkDir: (dir: string) => void;
	readImage: (path: string) => Buffer;
	writeBinary: typeof writeBinaryFile;
};

export const defaultVideoDeps: VideoDeps = {
	extract: extractFrames,
	makeWorkDir: () => mkdtempSync(join(tmpdir(), 'n8n-claude-video-')),
	removeWorkDir: (dir) => rmSync(dir, { recursive: true, force: true }),
	readImage: (path) => readFileSync(path),
	writeBinary: writeBinaryFile,
};

/** Images per video: the budget, less the item's other images, split evenly, at least one each. */
export function imagesPerVideo(maxImages: number, otherImages: number, videos: number): number {
	const room = Math.min(maxImages, MAX_IMAGES_PER_REQUEST - otherImages);
	return Math.max(1, Math.floor(room / videos));
}

const baseName = (fileName: string): string => fileName.replace(/\.[^.]+$/, '') || 'video';

/** A file to stage beside the inline images, for subagents, which cannot see those. */
export type FrameFile = { propName: string; fileName: string; mimeType: string; buffer: Buffer };

/**
 * The images as files named by the time they show, plus an index that maps each to its times.
 * The index is last. Names derive from the sanitized attachment name, so they stay inside the
 * staging directory.
 */
export function framesOnDisk(
	video: VideoAttachment,
	result: ExtractResult,
	readImage: (path: string) => Buffer,
): FrameFile[] {
	const base = baseName(video.fileName);
	const files: FrameFile[] = result.images.map((image, i) => ({
		propName: video.propName,
		fileName: `${base}-frame-${String(i).padStart(3, '0')}-${clock(image.timestamps[0] ?? 0).replace(/:/g, '-')}.jpg`,
		mimeType: 'image/jpeg',
		buffer: readImage(image.path),
	}));
	const index = {
		video: video.fileName,
		mode: result.report.mode,
		grid: result.report.grid,
		images: files.map((file, i) => ({
			file: file.fileName,
			timestamps: result.images[i].timestamps,
		})),
	};
	files.push({
		propName: video.propName,
		fileName: `${base}-frames.json`,
		mimeType: 'application/json',
		buffer: Buffer.from(`${JSON.stringify(index, null, 2)}\n`, 'utf8'),
	});
	return files;
}

/**
 * What the orchestrator is told about the staged frames. Separate from the staged-files hint,
 * which says a file was too large or had no inline route: these are copies of images it can see.
 */
export function framesHintBlock(dir: string, videos: VideoDiagnostics[]): ContentBlockParam {
	const lines = videos
		.filter((v) => v.stagedFrames)
		.map((v) => `  ${v.name}: ${v.stagedFrames?.files} images, index ${v.stagedFrames?.index}`);
	return {
		type: 'text',
		text: [
			`<video-frames-on-disk dir="${dir}">`,
			...lines,
			'</video-frames-on-disk>',
			'These are copies of the video images above, one file per image, named with the time it shows; each index file maps every image to its times. A subagent cannot see the images in this message: when you delegate work on a video, give the subagent these paths, and it can open each .jpg with the Read tool.',
		].join('\n'),
	};
}

/** The blocks for one video: what it is, its subtitles, then each image after its times. Pure. */
export function videoBlocks(
	video: VideoAttachment,
	result: ExtractResult,
	readImage: (path: string) => Buffer,
): ContentBlockParam[] {
	const subtitlesName = result.subtitles ? `${baseName(video.fileName)}.srt` : null;
	const blocks: ContentBlockParam[] = [
		{
			type: 'text',
			text: `Video: ${promptHint(result, video.fileName, subtitlesName, 'the caption before each image')}`,
		},
	];
	if (result.subtitles && subtitlesName) {
		blocks.push({
			type: 'document',
			title: subtitlesName,
			source: { type: 'text', media_type: 'text/plain', data: result.subtitles.text },
		});
	}
	const n = result.images.length;
	result.images.forEach((image, i) => {
		const times = image.timestamps.map(clock).join(', ');
		blocks.push(
			{
				type: 'text',
				text:
					result.report.mode === 'mosaic'
						? `${video.fileName}, image ${i + 1} of ${n}: ${times}`
						: `${video.fileName} at ${times}`,
			},
			{
				type: 'image',
				source: {
					type: 'base64',
					media_type: 'image/jpeg',
					data: readImage(image.path).toString('base64'),
				},
			},
		);
	});
	return blocks;
}

/** The core's own advice names the Video Frames option; here the way to it is a node away. */
function asAttachmentProblem(video: VideoAttachment, problem: Problem): Problem {
	const description = problem.description ?? '';
	return {
		message: `Video attachment "${video.propName}": ${problem.message}`,
		description: /FFmpeg Path/.test(description)
			? `${description} FFmpeg Path is an option of the Claude Code Video Frames node: put it before this one, or set Video Attachments to Stage the File.`
			: description || 'Set Video Attachments to Stage the File to send the file as it is.',
	};
}

export async function prepareVideos(
	ctx: BinaryFileContext,
	itemIndex: number,
	videos: VideoAttachment[],
	spec: AttachmentSpec,
	otherImages: number,
	run: { timeoutMs: number; signal?: AbortSignal; stageFrames?: boolean },
	deps: VideoDeps = defaultVideoDeps,
): Promise<
	| { blocks: ContentBlockParam[]; reports: VideoDiagnostics[]; frameFiles: FrameFile[] }
	| { problem: Problem }
> {
	const perVideo = imagesPerVideo(spec.video.maxImages, otherImages, videos.length);
	const blocks: ContentBlockParam[] = [];
	const reports: VideoDiagnostics[] = [];
	const frameFiles: FrameFile[] = [];

	for (const video of videos) {
		const workDir = deps.makeWorkDir();
		try {
			const ext = /\.([a-z0-9]{1,5})$/i.exec(video.fileName)?.[1].toLowerCase() ?? 'bin';
			const path = join(workDir, `input.${ext}`);
			await deps.writeBinary(ctx, itemIndex, video.propName, video.meta, path);
			const result = await deps.extract(
				{ path, fileName: video.fileName },
				{
					sampling: {
						mode: spec.video.mode,
						maxImages: perVideo,
						grid: 3,
						minIntervalSec: 1,
						startSec: null,
						endSec: null,
						framesLongEdge: FRAMES_LONG_EDGE,
						mosaicLongEdge: MOSAIC_LONG_EDGE,
					},
					burnTimestamps: true,
					includeSubtitles: true,
					ffmpegPath: '',
					// A Timeout that is not positive must not kill ffmpeg at once.
					timeoutMs: run.timeoutMs > 0 ? run.timeoutMs : 300_000,
					signal: run.signal,
					workDir,
				},
			);
			if ('problem' in result) return { problem: asAttachmentProblem(video, result.problem) };
			// Read once: the same bytes go inline and, for subagents, to disk.
			const images = new Map(
				result.images.map((image) => [image.path, deps.readImage(image.path)]),
			);
			const read = (path: string) => images.get(path) ?? deps.readImage(path);
			blocks.push(...videoBlocks(video, result, read));
			const report: VideoDiagnostics = {
				name: video.fileName,
				bytes: video.bytes,
				images: result.images.length,
				...result.report,
			};
			if (run.stageFrames) {
				const files = framesOnDisk(video, result, read);
				frameFiles.push(...files);
				report.stagedFrames = {
					dir: '',
					index: files[files.length - 1].fileName,
					files: files.length - 1,
					subagentsWithoutRead: [],
				};
			}
			reports.push(report);
		} finally {
			deps.removeWorkDir(workDir);
		}
	}
	return { blocks, reports, frameFiles };
}
