import type { ClaudeCodeParams } from '../ClaudeCode/types';
import {
	readSubNodeParams,
	usageWorkflowId,
	type SubNodeOptions,
	type SubNodeReadContext,
} from '../shared/subNodeParams';

/**
 * The only place this node reads parameters, mirroring the main node's `params.ts` contract:
 * everything downstream takes a plain `ClaudeCodeParams` and stays pure.
 *
 * The run parameters themselves come from `shared/subNodeParams.ts` — they are identical across
 * the sub-nodes and were duplicated once already. What lives here is what is genuinely this
 * node's own: how the conversation is carried, and how the Agent's system message is applied.
 */

export type SettingsReadContext = SubNodeReadContext;

export type SystemPromptMode = 'append' | 'replace';

/**
 * What the node's Memory selector offers. `auto` is a sentinel resolved here, never a behaviour
 * of its own — same shape as the main node's Attach All Binaries, and for the same reason: it
 * keeps the parameter's default meaning "exactly what this node did before the selector
 * existed", so adding it changes no stored workflow.
 */
export type MemorySourceSelection = 'auto' | 'session' | 'memory';

/** The resolved mode. `session` resumes a Claude Code session; `memory` flattens the connected
 * Memory sub-node's history into the prompt. */
export type MemoryMode = 'session' | 'memory';

export const resolveMemoryMode = (
	selection: MemorySourceSelection,
	sessionId: string,
): MemoryMode => {
	if (selection === 'session') return 'session';
	if (selection === 'memory') return 'memory';
	// auto: the pre-selector behaviour — a Session ID means session, its absence means memory.
	return sessionId !== '' ? 'session' : 'memory';
};

export type ChatModelSettings = {
	params: ClaudeCodeParams;
	systemPromptMode: SystemPromptMode;
	memoryMode: MemoryMode;
	debugEnabled: boolean;
	/** Empty when the node was not asked to report. */
	usageWorkflowId: string;
	processName: string;
};

type ChatModelOptions = SubNodeOptions & {
	systemPromptMode?: SystemPromptMode;
};

export function readChatModelSettings(
	ctx: SettingsReadContext,
	itemIndex: number,
): ChatModelSettings {
	const options = ctx.getNodeParameter('options', itemIndex, {}) as ChatModelOptions;

	// Session continuity: the value is either a session UUID handed back by a previous run or any
	// stable conversation key, hashed to one in the model. Session mode rides the main node's
	// `continue` path, so the existing `resumeOrContinue` applier is the whole implementation.
	//
	// Read with a fallback because n8n STRIPS a parameter whose displayOptions condition is not
	// met: in Memory mode the field is hidden and resolves to '' here, which is exactly the
	// intent — the same mechanism that governs Binary Properties on the main node.
	const sessionId = (ctx.getNodeParameter('sessionId', itemIndex, '') as string).trim();
	const memoryMode = resolveMemoryMode(
		ctx.getNodeParameter('memorySource', itemIndex, 'auto') as MemorySourceSelection,
		sessionId,
	);

	const params: ClaudeCodeParams = {
		...readSubNodeParams(ctx, itemIndex, options),
		operation: memoryMode === 'session' ? 'continue' : 'query',
		sessionId,
	};

	return {
		params,
		systemPromptMode: options.systemPromptMode ?? 'append',
		memoryMode,
		debugEnabled: options.debug === true,
		usageWorkflowId: usageWorkflowId(options.reportUsageTo),
		processName: (options.processName ?? '').trim(),
	};
}
