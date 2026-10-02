import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { Problem } from '../shared/problem';
import { extractFrames } from '../shared/video/extract';
import { videoFramesDescription } from './description';
import { stageInput } from './input';
import { buildOutputItem } from './output';
import { readVideoFramesParams } from './params';

export type VideoFramesDeps = {
	extract: typeof extractFrames;
	makeWorkDir: () => string;
	removeWorkDir: (dir: string) => void;
};

export const defaultVideoFramesDeps: VideoFramesDeps = {
	extract: extractFrames,
	makeWorkDir: () => mkdtempSync(join(tmpdir(), 'n8n-video-frames-')),
	removeWorkDir: (dir) => rmSync(dir, { recursive: true, force: true }),
};

export class ClaudeCodeVideoFrames implements INodeType {
	description: INodeTypeDescription = videoFramesDescription;

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return runVideoFrameItems(this, defaultVideoFramesDeps);
	}
}

async function runItem(
	ctx: IExecuteFunctions,
	itemIndex: number,
	deps: VideoFramesDeps,
	signal: AbortSignal,
): Promise<{ item: INodeExecutionData } | { problem: Problem }> {
	const params = readVideoFramesParams(ctx, itemIndex);
	const workDir = deps.makeWorkDir();
	try {
		const input = await stageInput(
			ctx,
			itemIndex,
			params.binaryProperty,
			params.maxVideoMb,
			workDir,
		);
		if ('problem' in input) return input;
		const result = await deps.extract(
			{ path: input.path, fileName: input.fileName },
			{
				sampling: params.sampling,
				burnTimestamps: params.burnTimestamps,
				includeSubtitles: params.includeSubtitles,
				ffmpegPath: params.ffmpegPath,
				timeoutMs: params.timeoutSec * 1000,
				signal,
				workDir,
			},
		);
		if ('problem' in result) return result;
		return { item: await buildOutputItem(ctx, itemIndex, params, input, result) };
	} finally {
		deps.removeWorkDir(workDir);
	}
}

export async function runVideoFrameItems(
	ctx: IExecuteFunctions,
	deps: VideoFramesDeps,
): Promise<INodeExecutionData[][]> {
	const items = ctx.getInputData();
	const returnData: INodeExecutionData[] = [];
	const abortController = new AbortController();
	ctx.onExecutionCancellation(() => abortController.abort());

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		let problem: Problem;
		try {
			const outcome = await runItem(ctx, itemIndex, deps, abortController.signal);
			if ('item' in outcome) {
				returnData.push(outcome.item);
				continue;
			}
			problem = outcome.problem;
		} catch (error) {
			problem = { message: error instanceof Error ? error.message : String(error) };
		}
		const { message, description } = problem;
		if (ctx.continueOnFail()) {
			returnData.push({
				json: { error: message, ...(description ? { description } : {}) },
				pairedItem: { item: itemIndex },
			});
			continue;
		}
		throw new NodeOperationError(ctx.getNode(), message, {
			itemIndex,
			...(description ? { description } : {}),
		});
	}

	return [returnData];
}
