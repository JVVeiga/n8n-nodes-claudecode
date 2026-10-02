import type { ExtractResult } from './types';

/** `hh:mm:ss`, and the same with dashes for a file name. */
export function clock(seconds: number): string {
	const s = Math.floor(seconds);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * One sentence for the prompt. The AI Agent forwards the pixels without names or captions, so
 * this is how a workflow tells the model what it is looking at: `{{ $json.promptHint }}`.
 */
export function promptHint(
	result: ExtractResult,
	fileName: string,
	subtitles: string | null,
	timesWithout = 'the image file names',
): string {
	const { report, images } = result;
	const n = images.length;
	const span = `${clock(report.coverage.fromSec)}–${clock(report.coverage.toSec)}`;
	const every = `${report.coverage.intervalSec < 10 ? report.coverage.intervalSec.toFixed(1) : Math.round(report.coverage.intervalSec)} s`;
	const labelled =
		report.labels === 'burned'
			? 'each labelled with its time in the top-left corner'
			: `their times are in ${timesWithout}`;
	const shape =
		report.mode === 'mosaic'
			? `${n} image${n === 1 ? '' : 's'} from the video ${fileName} (${clock(report.video.durationSec)} long), each a ${report.grid}×${report.grid} mosaic of moments read left to right, top to bottom, ${labelled}. Together they cover ${span}, one moment every ${every}.`
			: `${n} frame${n === 1 ? '' : 's'} from the video ${fileName} (${clock(report.video.durationSec)} long), in time order, ${labelled}, covering ${span}, one every ${every}.`;
	return subtitles ? `${shape} Its subtitles are attached as ${subtitles}.` : shape;
}
