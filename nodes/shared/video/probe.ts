import type { Problem } from '../problem';
import type { VideoInfo } from './types';

/**
 * `ffmpeg -i <file>` stderr -> VideoInfo. There is no ffprobe in the bundle; ffmpeg prints the same
 * facts and exits 1, which is the normal case here.
 */

const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'mov_text', 'ass', 'ssa', 'webvtt', 'text']);

const seconds = (hms: string): number => {
	const [h, m, s] = hms.split(':').map(Number);
	return h * 3600 + m * 60 + s;
};

type StreamBlock = { header: string; lines: string[] };

/** Input #0's stream headers, each with the metadata/side-data lines that follow it. */
function streamsOf(stderr: string): StreamBlock[] {
	const blocks: StreamBlock[] = [];
	for (const line of stderr.split('\n')) {
		if (/^Input #[1-9]/.test(line) || /^Output #/.test(line)) break;
		if (/^\s*Stream #0:\d+/.test(line)) blocks.push({ header: line, lines: [] });
		else if (blocks.length > 0) blocks[blocks.length - 1].lines.push(line);
	}
	return blocks;
}

function rotationOf(block: StreamBlock): number {
	for (const line of block.lines) {
		// The display matrix is what ffmpeg's autorotation applies; `rotate` metadata is its mirror.
		const matrix = /displaymatrix: rotation of (-?[\d.]+) degrees/.exec(line);
		if (matrix) return Math.round(Number(matrix[1]));
	}
	return 0;
}

export function parseProbe(
	stderr: string,
	fileName: string,
): { info: VideoInfo } | { problem: Problem } {
	const input = /^Input #0, (.+?), from /m.exec(stderr);
	if (!input) {
		const lastLine =
			stderr
				.trim()
				.split('\n')
				.filter((l) => l.trim())
				.pop() ?? '';
		return {
			problem: {
				message: `${fileName} could not be read as a video: ${lastLine.replace(/^.*?: /, '')}`,
				description: 'The file is damaged, incomplete, or not a video container ffmpeg recognises.',
			},
		};
	}

	const duration = /Duration: (N\/A|\d+:\d{2}:\d{2}(?:\.\d+)?), start: (-?[\d.]+)/.exec(stderr);
	const streams = streamsOf(stderr);
	// Cover art in an audio file is a video stream ffmpeg flags as an attached picture: not footage.
	const video = streams.find(
		(s) => /: Video: /.test(s.header) && !/\(attached pic\)/.test(s.header),
	);
	if (!video) {
		return {
			problem: {
				message: `${fileName} has no video stream`,
				description: streams.some((s) => /: Audio: /.test(s.header))
					? 'It is audio only. Speech is not supported yet; this node extracts frames from video.'
					: 'ffmpeg found no picture to extract frames from.',
			},
		};
	}

	const codec = /: Video: ([\w-]+)/.exec(video.header)?.[1] ?? 'unknown';
	const size = /, (\d{2,5})x(\d{2,5})[ ,[]/.exec(video.header);
	const fps = /, ([\d.]+) fps/.exec(video.header);
	const rotation = rotationOf(video);
	let width = size ? Number(size[1]) : 0;
	let height = size ? Number(size[2]) : 0;
	if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];

	let subtitleOrdinal = 0;
	const subtitles = streams
		.filter((s) => /: Subtitle: /.test(s.header))
		.map((s) => {
			const sub = /: Subtitle: ([\w-]+)/.exec(s.header)?.[1] ?? 'unknown';
			return { index: subtitleOrdinal++, codec: sub, textual: TEXT_SUBTITLE_CODECS.has(sub) };
		});

	return {
		info: {
			container: input[1],
			durationSec: duration && duration[1] !== 'N/A' ? seconds(duration[1]) : null,
			startSec: duration ? Number(duration[2]) : 0,
			codec,
			width,
			height,
			rotation,
			fps: fps ? Number(fps[1]) : null,
			hasAudio: streams.some((s) => /: Audio: /.test(s.header)),
			subtitles,
		},
	};
}
