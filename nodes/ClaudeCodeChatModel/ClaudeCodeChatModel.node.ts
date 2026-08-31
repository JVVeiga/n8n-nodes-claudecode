import type {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createDebugLogger } from '../shared/debug';
import { readAuth } from '../shared/readAuth';
import { createSequence } from '../shared/usageReport';
import { usageReporting } from '../shared/reportUsage';
import { claudeCodeChatModelDescription } from './description';
import { ClaudeCodeChat, type ChatModelLog } from './model';
import { readChatModelSettings } from './params';

/**
 * The node is a thin shell, like its two siblings: `supplyData` is a one-line adapter onto
 * `supplyChatModel(ctx, deps, itemIndex)`, which is the seam the tests use (n8n calls
 * `supplyData.call(context)`, so nothing can be constructor-injected).
 *
 * What it supplies is a LangChain-compatible chat model whose every `_generate` runs one Claude
 * Code session. Auth and parameters are read HERE, once, when the Agent asks for the model —
 * a bad credential or an unusable project path fails before the Agent ever runs.
 */

export type SupplyDeps = {
	/** The SDK's `query`. Injected so a test drives the message stream without spawning a CLI. */
	query: typeof query;
};

export class ClaudeCodeChatModel implements INodeType {
	description: INodeTypeDescription = claudeCodeChatModelDescription;

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		return supplyChatModel(this, { query }, itemIndex);
	}
}

export async function supplyChatModel(
	ctx: ISupplyDataFunctions,
	deps: SupplyDeps,
	itemIndex: number,
): Promise<SupplyData> {
	const settings = readChatModelSettings(ctx, itemIndex);
	const debug = createDebugLogger(ctx.logger, settings.debugEnabled);

	// Choosing Claude Code Session and leaving Session ID empty is not a stateless run, it is a
	// misconfiguration: the author asked for continuity and would silently get none. Fails here,
	// before the Agent runs, the same way a credential mode with no credential does.
	if (settings.memoryMode === 'session' && settings.params.sessionId === '') {
		throw new NodeOperationError(
			ctx.getNode(),
			'Conversation Memory is set to Claude Code Session, but Session ID is empty',
			{
				itemIndex,
				description:
					'Put a stable key for the conversation in Session ID — a chat/user id straight off the trigger, e.g. {{ $json.body.sessionId }} — or set Conversation Memory to n8n Memory Sub-Node.',
			},
		);
	}

	const authOutcome = await readAuth(ctx, itemIndex);
	if ('problem' in authOutcome) {
		throw new NodeOperationError(ctx.getNode(), authOutcome.problem.message, {
			itemIndex,
			...(authOutcome.problem.description ? { description: authOutcome.problem.description } : {}),
		});
	}

	// The R10 pair: without it the Agent's log shows a model that "did nothing" (spec F-09).
	// `addInputData` throws outside a real execution (e.g. some editor probes); the model must
	// still work there, so the log degrades to nothing rather than failing the run.
	const log: ChatModelLog = {
		start: (payload) => {
			try {
				return ctx.addInputData(NodeConnectionType.AiLanguageModel, [
					[{ json: payload as IDataObject }],
				]).index;
			} catch {
				return -1;
			}
		},
		end: (index, payload) => {
			if (index < 0) return;
			try {
				void ctx.addOutputData(NodeConnectionType.AiLanguageModel, index, [
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
				void ctx.addOutputData(NodeConnectionType.AiLanguageModel, index, wrapped);
			} catch {
				// Same.
			}
		},
	};

	// One sequence per supplyData — that is once per execution, so the numbering it produces is
	// the call number WITHIN this execution, which is exactly what run_key needs.
	const nextSeq = createSequence();

	const model = new ClaudeCodeChat({
		params: settings.params,
		systemPromptMode: settings.systemPromptMode,
		auth: authOutcome.auth,
		query: deps.query,
		debug,
		log,
		cancelSignal: ctx.getExecutionCancelSignal?.(),
		usage: usageReporting(ctx, settings, debug, nextSeq, itemIndex),
	});

	return { response: model };
}
