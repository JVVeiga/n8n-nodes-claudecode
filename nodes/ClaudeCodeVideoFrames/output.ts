import { readFileSync } from 'node:fs';
import type {
	IBinaryKeyData,
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
} from 'n8n-workflow';
import { clock, promptHint } from '../shared/video/hint';
import type { ExtractResult } from '../shared/video/types';

export { clock, promptHint };
import type { VideoFramesParams } from './params';
import type { StagedInput } from './input';

/** Extraction result -> the output item: image binaries in time order, plus what they show. */

export type OutputContext = Pick<IExecuteFunctions, 'getInputData' | 'helpers'>;

const baseName = (fileName: string): string => fileName.replace(/\.[^.]+$/, '') || 'video';

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
