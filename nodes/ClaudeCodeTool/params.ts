import type { ClaudeCodeParams } from '../ClaudeCode/types';
import {
	readSubNodeParams,
	type SubNodeOptions,
	type SubNodeReadContext,
} from '../shared/subNodeParams';

/**
 * The only place this node reads parameters. The run parameters come from
 * `shared/subNodeParams.ts`; what is this node's own is the tool description the Agent reads.
 *
 * `prompt` stays empty there on purpose: the task arrives per invocation, from the Agent, as the
 * tool's single argument — it is never a node parameter.
 */

export type ToolSettingsReadContext = SubNodeReadContext;

export type ClaudeCodeToolSettings = {
	params: ClaudeCodeParams;
	toolDescription: string;
	debugEnabled: boolean;
};

export function readClaudeCodeToolSettings(
	ctx: ToolSettingsReadContext,
	itemIndex: number,
): ClaudeCodeToolSettings {
	const options = ctx.getNodeParameter('options', itemIndex, {}) as SubNodeOptions;

	return {
		params: readSubNodeParams(ctx, itemIndex, options),
		toolDescription: (ctx.getNodeParameter('toolDescription', itemIndex) as string).trim(),
		debugEnabled: options.debug === true,
	};
}
