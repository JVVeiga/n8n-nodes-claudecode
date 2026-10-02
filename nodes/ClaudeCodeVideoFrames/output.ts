import { readFileSync } from 'node:fs';
import type {
	IBinaryKeyData,
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
} from 'n8n-workflow';
import type { ExtractResult } from '../shared/video/types';
import type { VideoFramesParams } from './params';
import type { StagedInput } from './input';

/** Extraction result -> the output item: image binaries in time order, plus what they show. */

export type OutputContext = Pick<IExecuteFunctions, 'getInputData' | 'helpers'>;

/** `hh:mm:ss`, and the same with dashes for a file name. */
export function clock(seconds: number): string {
	const s = Math.floor(seconds);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const baseName = (fileName: string): string => fileName.replace(/\.[^.]+$/, '') || 'video';

/**
 * One sentence for the prompt. The AI Agent forwards the pixels without names or captions, so
 * this is how a workflow tells the model what it is looking at: `{{ $json.promptHint }}`.
 */
export function promptHint(
	result: ExtractResult,
	fileName: string,
	subtitles: string | null,
): string {
	const { report, images } = result;
	const n = images.length;
	const span = `${clock(report.coverage.fromSec)}–${clock(report.coverage.toSec)}`;
	const every = `${report.coverage.intervalSec < 10 ? report.coverage.intervalSec.toFixed(1) : Math.round(report.coverage.intervalSec)} s`;
	const labelled =
		report.labels === 'burned'
			? 'each labelled with its time in the top-left corner'
			: 'their times are in the image file names';
	const shape =
		report.mode === 'mosaic'
			? `${n} image${n === 1 ? '' : 's'} from the video ${fileName} (${clock(report.video.durationSec)} long), each a ${report.grid}×${report.grid} mosaic of moments read left to right, top to bottom, ${labelled}. Together they cover ${span}, one moment every ${every}.`
			: `${n} frame${n === 1 ? '' : 's'} from the video ${fileName} (${clock(report.video.durationSec)} long), in time order, ${labelled}, covering ${span}, one every ${every}.`;
	return subtitles ? `${shape} Its subtitles are attached as ${subtitles}.` : shape;
}

export async function buildOutputItem(
	ctx: OutputContext,
	itemIndex: number,
	params: VideoFramesParams,
	input: StagedInput,
	result: ExtractResult,
): Promise<INodeExecutionData> {
	const original = ctx.getInputData()[itemIndex];
	const binary: IBinaryKeyData = {};
	for (const [name, data] of Object.entries(original?.binary ?? {})) {
		if (name !== params.binaryProperty || params.keepInputBinary) binary[name] = data;
	}

	const images: IDataObject[] = [];
	for (const [i, image] of result.images.entries()) {
		const property = `${params.outputPrefix}_${String(i).padStart(3, '0')}`;
		const fileName = `${property}_${clock(image.timestamps[0] ?? 0).replace(/:/g, '-')}.jpg`;
		binary[property] = await ctx.helpers.prepareBinaryData(
			readFileSync(image.path),
			fileName,
			'image/jpeg',
		);
		images.push({ property, fileName, timestamps: image.timestamps });
	}

	let subtitleFile: string | null = null;
	if (result.subtitles) {
		subtitleFile = `${baseName(input.fileName)}.srt`;
		binary.subtitles = await ctx.helpers.prepareBinaryData(
			Buffer.from(result.subtitles.text, 'utf8'),
			subtitleFile,
			'text/plain',
		);
	}

	const { report } = result;
	return {
		json: {
			video: { fileName: input.fileName, bytes: input.bytes, ...report.video },
			mode: report.mode,
			strategy: report.strategy,
			grid: report.grid,
			coverage: report.coverage,
			labels: report.labels,
			images,
			subtitles: report.subtitles ? { property: 'subtitles', ...report.subtitles } : null,
			notes: report.notes,
			promptHint: promptHint(result, input.fileName, subtitleFile),
			ffmpeg: report.ffmpeg,
			elapsedMs: report.elapsedMs,
		},
		binary,
		pairedItem: { item: itemIndex },
	};
}
