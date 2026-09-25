import type {
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { SUBAGENT_TAG, type SuppliedSubagent } from '../shared/subagent';
import { subagentRunLog } from '../shared/subagentLog';
import { claudeCodeSubagentDescription } from './description';
import { readSubagentParams } from './params';

export class ClaudeCodeSubagent implements INodeType {
	description: INodeTypeDescription = claudeCodeSubagentDescription;

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		return supplySubagent(this, itemIndex);
	}
}

/** Nothing runs here: the Agent reads the definition and the run happens in its session. */
export function supplySubagent(ctx: ISupplyDataFunctions, itemIndex: number): SupplyData {
	const outcome = readSubagentParams(ctx, itemIndex);
	if ('problem' in outcome) {
		throw new NodeOperationError(ctx.getNode(), outcome.problem.message, {
			itemIndex,
			...(outcome.problem.description ? { description: outcome.problem.description } : {}),
		});
	}

	const subagent: SuppliedSubagent = {
		[SUBAGENT_TAG]: 1,
		name: outcome.name,
		definition: outcome.definition,
		log: subagentRunLog(ctx),
	};
	return { response: subagent };
}
