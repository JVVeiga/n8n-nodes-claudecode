import type { ISupplyDataFunctions } from 'n8n-workflow';
import { NodeConnectionType } from 'n8n-workflow';
import type { SubagentInvocation } from './subagent';
import { toolRunLog } from './toolRunLog';

/**
 * Records one delegation on the Subagent sub-node's own run log: the prompt it was handed in,
 * the summary and usage out. A status other than 'completed' is still an output — it is what
 * the run reported, not an error of this node.
 */
export const subagentRunLog = (ctx: ISupplyDataFunctions) => {
	const log = toolRunLog(ctx, NodeConnectionType.AiAgent);
	return (invocation: SubagentInvocation): void => {
		const index = log.start({ prompt: invocation.prompt, description: invocation.description });
		log.end(index, {
			status: invocation.status,
			summary: invocation.summary,
			totalTokens: invocation.totalTokens,
			toolUses: invocation.toolUses,
			durationMs: invocation.durationMs,
		});
	};
};
