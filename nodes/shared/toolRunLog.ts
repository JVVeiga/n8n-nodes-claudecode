import type { IDataObject, ISupplyDataFunctions } from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';

/**
 * What every `ai_tool` sub-node needs to be visible and correctly named.
 *
 * It lived in `ClaudeCodeTool/ClaudeCodeTool.node.ts` and the Usage tool imported it from there —
 * one node reaching into another node's class file, which meant loading the Usage tool pulled in
 * the Task tool's whole module graph (its description, its params, the SDK's `query`). This is
 * the same extraction `shared/projectPath.ts` and `shared/auth.ts` got, for the same reason.
 */

/** The R10 trio. `error` exists so a failed run is CLOSED as failed rather than left open. */
export type ToolRunLog = {
	start: (payload: Record<string, unknown>) => number;
	end: (index: number, payload: Record<string, unknown>) => void;
	error: (index: number, error: unknown) => void;
};

/**
 * The tool's wire name, derived from the node's name the way n8n's own node-as-tool does — so
 * renaming the node on the canvas renames the tool the model sees.
 *
 * `.` is NOT in the allowed set: Anthropic requires tool names to match `^[a-zA-Z0-9_-]{1,128}$`,
 * so a node called "Claude Code v1.2" would otherwise produce `mcp__n8n__Claude_Code_v1.2` and
 * the API would reject the tool definition outright.
 */
export const toToolName = (nodeName: string, fallback = 'Claude_Code_Tool'): string =>
	nodeName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || fallback;

/**
 * Registers a tool's calls under its node on the canvas, the way n8n's own Code Tool does.
 * Every call is guarded: `addInputData` throws outside a real execution (an editor probe, for
 * instance), and logging must never be the thing that fails a run.
 */
export const toolRunLog = (ctx: ISupplyDataFunctions): ToolRunLog => ({
	start: (payload) => {
		try {
			return ctx.addInputData(NodeConnectionType.AiTool, [[{ json: payload as IDataObject }]])
				.index;
		} catch {
			return -1;
		}
	},
	end: (index, payload) => {
		if (index < 0) return;
		try {
			void ctx.addOutputData(NodeConnectionType.AiTool, index, [
				[{ json: payload as IDataObject }],
			]);
		} catch {
			// Logging must never fail the run.
		}
	},
	error: (index, error) => {
		if (index < 0) return;
		try {
			const wrapped =
				error instanceof NodeOperationError
					? error
					: new NodeOperationError(ctx.getNode(), error as Error);
			void ctx.addOutputData(NodeConnectionType.AiTool, index, wrapped);
		} catch {
			// Same.
		}
	},
});
