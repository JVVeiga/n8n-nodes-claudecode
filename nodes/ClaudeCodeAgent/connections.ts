import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeConnectionType } from 'n8n-workflow';
import { flattenTools, type BindableTool } from '../shared/toolBridge';

export type ConnectionReadContext = {
	getInputConnectionData: IExecuteFunctions['getInputConnectionData'];
};

export type AgentConnections = {
	tools: BindableTool[];
	/** Validated by buildSubagents. */
	subagents: unknown;
	/** Validated by resolveOutputSchema, and only in Output Parser mode. */
	parser: unknown;
};

export async function readConnections(
	ctx: ConnectionReadContext,
	itemIndex: number,
): Promise<AgentConnections> {
	const tools = await ctx.getInputConnectionData(NodeConnectionType.AiTool, itemIndex);
	const subagents = await ctx.getInputConnectionData(NodeConnectionType.AiAgent, itemIndex);
	const parser = await ctx.getInputConnectionData(NodeConnectionType.AiOutputParser, itemIndex);
	// n8n hands a single-connection input back unwrapped; tolerate an array all the same.
	return {
		tools: flattenTools(tools),
		subagents,
		parser: Array.isArray(parser) ? parser[0] : parser,
	};
}
