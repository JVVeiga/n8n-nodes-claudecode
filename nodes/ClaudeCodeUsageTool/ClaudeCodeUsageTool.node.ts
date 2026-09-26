import type {
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { createDebugLogger } from '../shared/debug';
import { readAuth } from '../shared/readAuth';
import { text } from '../shared/text';
import { toolRunLog, toToolName } from '../shared/toolRunLog';
import type { readUsage as realReadUsage } from '../ClaudeCodeUsage/readUsage';
import { claudeCodeUsageToolDescription } from './description';
import { buildClaudeCodeUsageTool } from './tool';

export type SupplyUsageToolDeps = {
	/** Injected so a test never spawns a real CLI. Absent means the real reader. */
	readUsage?: typeof realReadUsage;
};

type UsageToolNodeOptions = {
	timeout?: number;
	declareProfileScope?: boolean;
	probeIfUnavailable?: boolean;
	includeAccountEmail?: boolean;
	pathToClaudeCodeExecutable?: string;
	debug?: boolean;
};

export class ClaudeCodeUsageTool implements INodeType {
	description: INodeTypeDescription = claudeCodeUsageToolDescription;

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		return supplyClaudeCodeUsageTool(this, {}, itemIndex);
	}
}

export async function supplyClaudeCodeUsageTool(
	ctx: ISupplyDataFunctions,
	deps: SupplyUsageToolDeps,
	itemIndex: number,
): Promise<SupplyData> {
	const options = ctx.getNodeParameter('options', itemIndex, {}) as UsageToolNodeOptions;
	const toolDescription = text(ctx.getNodeParameter('toolDescription', itemIndex)).trim();
	const debug = createDebugLogger(ctx.logger, options.debug === true);

	const authOutcome = await readAuth(ctx, itemIndex);
	if ('problem' in authOutcome) {
		throw new NodeOperationError(ctx.getNode(), authOutcome.problem.message, {
			itemIndex,
			...(authOutcome.problem.description ? { description: authOutcome.problem.description } : {}),
		});
	}

	const tool = buildClaudeCodeUsageTool({
		name: toToolName(ctx.getNode().name),
		description: toolDescription,
		auth: authOutcome.auth,
		debug,
		log: toolRunLog(ctx),
		readUsage: deps.readUsage,
		options: {
			timeoutMs: Math.max(5, options.timeout ?? 60) * 1000,
			cwd: text(ctx.getNodeParameter('projectPath', itemIndex, '')).trim() || undefined,
			pathToClaudeCodeExecutable: text(options.pathToClaudeCodeExecutable).trim() || undefined,
			declareProfileScope: options.declareProfileScope !== false,
			probeIfUnavailable: options.probeIfUnavailable === true,
			includeAccountEmail: options.includeAccountEmail === true,
		},
	});

	return { response: tool };
}
