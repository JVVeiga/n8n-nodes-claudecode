import type {
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createDebugLogger } from '../shared/debug';
import { readAuth } from '../shared/readAuth';
import { toolRunLog, toToolName } from '../shared/toolRunLog';
import { createSequence } from '../shared/usageReport';
import { usageReporting } from '../shared/reportUsage';
import { claudeCodeToolDescription } from './description';
import { readClaudeCodeToolSettings } from './params';
import { buildClaudeCodeTaskTool } from './tool';

/**
 * The thin shell, like its three siblings: `supplyData` adapts onto
 * `supplyClaudeCodeTool(ctx, deps, itemIndex)`, the seam the tests use. Auth and parameters are
 * read here, once, when the Agent asks for the tool — a bad credential fails before anything is
 * spawned or billed.
 */

export type SupplyToolDeps = {
	/** The SDK's `query`. Injected so a test drives the message stream without spawning a CLI. */
	query: typeof query;
};

export class ClaudeCodeTool implements INodeType {
	description: INodeTypeDescription = claudeCodeToolDescription;

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		return supplyClaudeCodeTool(this, { query }, itemIndex);
	}
}

export async function supplyClaudeCodeTool(
	ctx: ISupplyDataFunctions,
	deps: SupplyToolDeps,
	itemIndex: number,
): Promise<SupplyData> {
	const settings = readClaudeCodeToolSettings(ctx, itemIndex);
	const debug = createDebugLogger(ctx.logger, settings.debugEnabled);

	const authOutcome = await readAuth(ctx, itemIndex);
	if ('problem' in authOutcome) {
		throw new NodeOperationError(ctx.getNode(), authOutcome.problem.message, {
			itemIndex,
			...(authOutcome.problem.description ? { description: authOutcome.problem.description } : {}),
		});
	}

	const tool = buildClaudeCodeTaskTool({
		name: toToolName(ctx.getNode().name, 'Claude_Code_Task'),
		description: settings.toolDescription,
		params: settings.params,
		auth: authOutcome.auth,
		query: deps.query,
		debug,
		log: toolRunLog(ctx),
		cancelSignal: ctx.getExecutionCancelSignal?.(),
		usage: usageReporting(ctx, settings, debug, createSequence(), itemIndex),
	});

	return { response: tool };
}
