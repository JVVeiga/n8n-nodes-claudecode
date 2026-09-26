import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { Problem } from '../shared/problem';
import { isDirectory } from '../shared/projectPath';
import { codeReviewKitDescription } from './description';
import { createGit } from './git';
import { runOperation, type KitDeps } from './operations';
import { readKitParams } from './params';

export type { KitDeps } from './operations';

export class CodeReviewKit implements INodeType {
	description: INodeTypeDescription = codeReviewKitDescription;

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return runKitItems(this, { git: createGit, pathExists: isDirectory });
	}
}

export async function runKitItems(
	ctx: IExecuteFunctions,
	deps: KitDeps,
): Promise<INodeExecutionData[][]> {
	const items = ctx.getInputData();
	const returnData: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		let problem: Problem;
		try {
			const outcome = await runOperation(readKitParams(ctx, itemIndex), deps);
			if ('json' in outcome) {
				returnData.push({ json: outcome.json, pairedItem: { item: itemIndex } });
				continue;
			}
			problem = outcome.problem;
		} catch (error) {
			// An expression that fails to resolve lands here, and continueOnFail still applies.
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
