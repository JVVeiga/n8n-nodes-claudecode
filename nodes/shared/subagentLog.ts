import type { IDataObject, ISupplyDataFunctions } from 'n8n-workflow';
import { NodeConnectionType } from 'n8n-workflow';
import type { SubagentInvocation } from './subagent';

/**
 * Records one delegation on the Subagent sub-node's own run log: the prompt it was handed in,
 * the summary and usage out. A status other than 'completed' is still an output — it is what
 * the run reported, not an error of this node. Outside a real execution `addInputData` throws,
 * and logging must never be what fails the Agent, so every call is guarded.
 */
export const subagentRunLog =
	(ctx: ISupplyDataFunctions) =>
	(invocation: SubagentInvocation): void => {
		let index: number;
		try {
			const input: IDataObject = {
				prompt: invocation.prompt,
				description: invocation.description,
			};
			index = ctx.addInputData(NodeConnectionType.AiAgent, [[{ json: input }]]).index;
		} catch {
			return;
		}
		try {
			const output: IDataObject = {
				status: invocation.status,
				summary: invocation.summary,
				totalTokens: invocation.totalTokens,
				toolUses: invocation.toolUses,
				durationMs: invocation.durationMs,
			};
			void ctx.addOutputData(NodeConnectionType.AiAgent, index, [[{ json: output }]]);
		} catch {
			// Logging must never fail the run.
		}
	};
