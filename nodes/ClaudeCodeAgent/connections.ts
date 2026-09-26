import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeConnectionType } from 'n8n-workflow';
import type { Problem } from '../shared/problem';
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

const sourceOf = (tool: BindableTool): string => {
	const name = tool.metadata?.sourceNodeName;
	return typeof name === 'string' && name !== '' ? `"${name}"` : 'an unnamed node';
};

/** The bridge registers tools by name, so two with one name cannot both reach the run. */
export function checkToolNames(tools: BindableTool[]): Problem | null {
	const byName = new Map<string, BindableTool[]>();
	for (const tool of tools) byName.set(tool.name, [...(byName.get(tool.name) ?? []), tool]);
	for (const [name, same] of byName) {
		if (same.length < 2) continue;
		const sources = same.map(sourceOf);
		return {
			message: `Two connected tools are both named "${name}"`,
			description:
				`${sources.slice(0, -1).join(', ')} and ${sources[sources.length - 1]} give a tool the ` +
				'same name. A tool node is named after the node, so rename one of them; for an MCP ' +
				'Client, leave the tool out of one of its Tools to Include.',
		};
	}
	return null;
}
