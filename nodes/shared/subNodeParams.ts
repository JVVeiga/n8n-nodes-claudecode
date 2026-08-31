import type { IExecuteFunctions } from 'n8n-workflow';
import type { ClaudeCodeParams, EffortSelection, ThinkingSelection } from '../ClaudeCode/types';

/**
 * The run parameters every sub-node reads.
 *
 * The Chat Model and the Task Tool each built a `ClaudeCodeParams` and the two blocks were
 * identical bar two lines — the whole neutral-`attachments` block and every `?? 25 / ?? 300 /
 * ?? 60` default, twice. That is exactly the drift `shared/projectPath.ts` exists to prevent:
 * a default corrected in one node and forgotten in the other is invisible until someone compares
 * two runs.
 *
 * What stays with each node is what genuinely differs: how the conversation is carried (session
 * vs memory) for the Chat Model, and the tool description for the tools.
 */

export type SubNodeReadContext = {
	getNodeParameter: IExecuteFunctions['getNodeParameter'];
	getNode: IExecuteFunctions['getNode'];
};

/** The `options` collection every sub-node offers. Optional throughout: an unset collection
 * field arrives as `undefined`, which is why the defaults live here and not in the schema. */
export type SubNodeOptions = {
	effort?: EffortSelection;
	maxTurns?: number;
	timeout?: number;
	wrapUpGraceSeconds?: number;
	maxBudgetUsd?: number;
	fallbackModel?: string;
	thinking?: ThinkingSelection;
	maxThinkingTokens?: number;
	restrictTools?: string[];
	disallowedTools?: string[];
	allowedTools?: string[];
	systemPrompt?: string;
	pathToClaudeCodeExecutable?: string;
	debug?: boolean;
	/** Workflow that receives { process_name, run_key, …, metrics, diagnostics } after each call.
	 * A workflowSelector resolves to a resource-locator object, or a bare id string. */
	reportUsageTo?: string | { value?: string };
	processName?: string;
};

/** The workflowSelector parameter resolves to `{ __rl: true, value, mode }` when picked from the
 * list and to a plain string when typed — both mean the same workflow. */
export const usageWorkflowId = (value: SubNodeOptions['reportUsageTo']): string =>
	(typeof value === 'string' ? value : (value?.value ?? '')).trim();

/**
 * Builds the params a sub-node hands to `buildQueryOptions`. `prompt` stays empty on purpose —
 * it arrives per invocation (from the Agent's messages, or as the tool's `task`), never as a
 * node parameter. Attachments are off: a sub-node is handed messages, not binary items. The
 * output format is meaningless because nothing here emits an item.
 */
export function readSubNodeParams(
	ctx: SubNodeReadContext,
	itemIndex: number,
	options: SubNodeOptions,
): ClaudeCodeParams {
	return {
		operation: 'query',
		sessionId: '',
		prompt: '',
		model: ctx.getNodeParameter('model', itemIndex) as string,
		effort: options.effort ?? 'high',
		maxTurns: options.maxTurns ?? 25,
		timeoutSeconds: options.timeout ?? 300,
		projectPath: ctx.getNodeParameter('projectPath', itemIndex, '') as string,
		outputFormat: 'text',
		allowedTools: options.allowedTools ?? [],
		disallowedTools: options.disallowedTools ?? [],
		restrictTools: options.restrictTools ?? [],
		attachments: {
			all: false,
			names: [],
			inlineTextLimitKb: 256,
			maxAttachmentMb: 50,
			maxAttachmentCount: 16,
			allowedExtensions: [],
		},
		additional: {
			systemPrompt: options.systemPrompt || undefined,
			permissionMode: 'bypassPermissions',
			debug: options.debug === true,
			fallbackModel: options.fallbackModel || undefined,
			maxThinkingTokens: options.maxThinkingTokens,
			maxBudgetUsd: options.maxBudgetUsd,
			thinking: options.thinking,
			wrapUpGraceSeconds: options.wrapUpGraceSeconds ?? 60,
			pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
		},
		nodeVersion: ctx.getNode().typeVersion,
		itemIndex,
	};
}
