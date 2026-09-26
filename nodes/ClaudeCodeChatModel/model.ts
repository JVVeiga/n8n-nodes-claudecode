import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
	BaseChatModel,
	type BaseChatModelCallOptions,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { AuthSelection } from '../shared/auth';
import type { DebugLogger } from '../shared/debug';
import { attachAbort } from '../shared/abort';
import { preview } from '../shared/preview';
import { withFinalResultOnly } from '../shared/sdkMessage';
import { buildQueryOptions } from '../ClaudeCode/config';
import { createPromptStream } from '../ClaudeCode/promptStream';
import { runQuery } from '../ClaudeCode/runner';
import type { ClaudeCodeParams } from '../ClaudeCode/types';
import { mapMessages } from './messages';
import { resolveChatOutcome } from './result';
import { buildToolBridge, type BindableTool } from '../shared/toolBridge';
import { reportRun, type UsageReporting } from '../shared/usageReport';
import { runWithSession, toSessionUuid, type SessionRequest } from '../shared/session';

/**
 * Claude Code, duck-typed as a LangChain chat model.
 *
 * The Agent's gate is `lc_namespace.includes('chat_models')` plus a `bindTools` method (spec
 * F-01), and everything it does afterwards — `invoke` through `RunnableSequence`, message
 * checks, callbacks — is duck-typed too (F-06). Extending OUR `@langchain/core`'s BaseChatModel
 * therefore works whether n8n resolves this class against its own copy of the library or a
 * nested one.
 *
 * One run of `_generate` is one CLI process: prompt in, agent loop inside (the Agent's tools
 * included, via the MCP bridge — DEC-CM1), final text out. No n8n context in here; everything
 * impure arrives through `deps`, which is what the tests replace.
 */

export type ChatModelLog = {
	/** Register the call in the sub-node's execution log; returns the run index. */
	start: (payload: Record<string, unknown>) => number;
	end: (index: number, payload: Record<string, unknown>) => void;
	error: (index: number, error: unknown) => void;
};

export type ChatModelDeps = {
	params: ClaudeCodeParams;
	/** DEC-CM4: append puts the Agent's system message into the preset's `append` slot; replace
	 * hands it to the SDK as the whole system prompt. */
	systemPromptMode: 'append' | 'replace';
	/** Answer from the run's final result and keep the run open for a background subagent. */
	finalResultOnly?: boolean;
	auth: AuthSelection;
	query: typeof sdkQuery;
	debug: DebugLogger;
	log?: ChatModelLog;
	/** The execution's cancel signal, when the caller has one. */
	cancelSignal?: AbortSignal;
	/** Injected so tests never read the real process environment. */
	processEnv?: NodeJS.ProcessEnv;
	/** Reporting, whole or not at all — see UsageReporting. Absent means the node was not asked
	 * to report. */
	usage?: UsageReporting;
};

type BindToolsArg = Parameters<NonNullable<BaseChatModel['bindTools']>>[0];

/** Text deltas of the top-level assistant stream, ignoring tool-input deltas and subagents. */
const textDeltaOf = (message: SDKMessage): string | null => {
	if (message.type !== 'stream_event' || message.parent_tool_use_id !== null) return null;
	const event = message.event as {
		type?: string;
		delta?: { type?: string; text?: string };
	};
	if (event.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') return null;
	return event.delta.text ?? null;
};

export class ClaudeCodeChat extends BaseChatModel<BaseChatModelCallOptions> {
	/** What `isChatInstance` reads. Declared explicitly rather than inherited so the gate never
	 * depends on which copy of `@langchain/core` constructed the instance. */
	lc_namespace = ['n8n_nodes_claudecode', 'chat_models', 'claude_code'];

	private readonly deps: ChatModelDeps;

	private readonly boundTools: BindableTool[];

	constructor(deps: ChatModelDeps, boundTools: BindableTool[] = []) {
		super({});
		this.deps = deps;
		this.boundTools = boundTools;
	}

	_llmType(): string {
		return 'claude-code';
	}

	override invocationParams(): Record<string, unknown> {
		const { params } = this.deps;
		return {
			model: params.model,
			effort: params.effort,
			max_turns: params.maxTurns,
			timeout_seconds: params.timeoutSeconds,
			tools: this.boundTools.map((tool) => tool.name),
		};
	}

	/** A NEW instance carrying the tools, leaving this one untouched — `createToolCallingAgent`
	 * calls this once per agent build, and a mutated original would leak tools across items. */
	override bindTools(tools: BindToolsArg, _kwargs?: unknown): ClaudeCodeChat {
		return new ClaudeCodeChat(this.deps, [
			...this.boundTools,
			...(tools as unknown[] as BindableTool[]),
		]);
	}

	async _generate(
		messages: BaseMessage[],
		options: this['ParsedCallOptions'],
		runManager?: CallbackManagerForLLMRun,
	): Promise<ChatResult> {
		const { deps } = this;
		// Session mode means the Claude Code session holds the real conversation, so the
		// flattened Memory history is omitted — sending both would put every prior turn in the
		// context twice. The mode is resolved in params.ts; `operation` carries it here.
		const sessionUuid =
			deps.params.operation === 'continue' && deps.params.sessionId !== ''
				? toSessionUuid(deps.params.sessionId)
				: null;
		const mapped = mapMessages(messages, { history: sessionUuid ? 'omit' : 'flatten' });

		// DEC-CM4. Append mode combines the node's own System Prompt option with the Agent's
		// system message in the preset's `append` slot; replace mode hands the Agent's message to
		// the SDK as the entire system prompt (the node option does not apply — there is no slot
		// left for it to mean anything).
		const appended = [deps.params.additional.systemPrompt, mapped.system]
			.filter((part): part is string => typeof part === 'string' && part !== '')
			.join('\n\n');
		const callParams: ClaudeCodeParams = {
			...deps.params,
			additional: {
				...deps.params.additional,
				systemPrompt: deps.systemPromptMode === 'append' && appended !== '' ? appended : undefined,
			},
		};

		const bridge = buildToolBridge(this.boundTools, (toolName, error) =>
			deps.debug.error(`Bridged tool failed: ${toolName}`, {
				error: error instanceof Error ? error.message : String(error),
			}),
		);

		const abortController = new AbortController();
		const abort = () => abortController.abort();
		// Detached in the finally below. `options.signal` is per call and harmless, but
		// `deps.cancelSignal` is read once in supplyData and shared by every call this model
		// serves — one listener per agent step would accumulate until Node warns about a leak.
		const listening = attachAbort([options.signal, deps.cancelSignal], abort);

		let appliedEffort: string | undefined;
		/** Serialises the streaming callbacks; awaited before the result is returned. */
		let tokenQueue: Promise<void> = Promise.resolve();
		// One budget for the whole call, so the resume-then-create retry cannot spend the
		// configured timeout twice (a 300s node occupying 600s of wall clock).
		const startedAt = Date.now();

		/** One CLI run; runWithSession decides which session it targets and its time budget. */
		const runOnce = async (session: SessionRequest, budget: { timeoutSeconds: number }) => {
			const promptStream = createPromptStream(mapped.prompt);
			const budgeted: ClaudeCodeParams = { ...callParams, timeoutSeconds: budget.timeoutSeconds };
			const runParams: ClaudeCodeParams =
				session && 'resume' in session
					? { ...budgeted, operation: 'continue', sessionId: session.resume }
					: { ...budgeted, operation: 'query', sessionId: '' };
			const outcome = buildQueryOptions(runParams, {
				abortController,
				promptStream,
				auth: deps.auth,
				processEnv: deps.processEnv,
				onEffort: (level) => {
					appliedEffort = level;
				},
				mcp: bridge ?? undefined,
				systemPromptReplace:
					deps.systemPromptMode === 'replace' ? (mapped.system ?? '') : undefined,
				includePartialMessages: true,
				newSessionId: session && 'create' in session ? session.create : undefined,
			});
			if ('problem' in outcome) {
				const { problem } = outcome;
				throw new Error(
					problem.description ? `${problem.message} — ${problem.description}` : problem.message,
				);
			}
			const sdkMessages: SDKMessage[] = [];
			const run = await runQuery({
				queryOptions: outcome.config.queryOptions,
				graceWindow: outcome.config.graceWindow,
				promptStream,
				abortController,
				query: deps.query,
				debug: deps.debug,
				messages: sdkMessages,
				getAppliedEffort: () => appliedEffort,
				pendingTasksKeepRunOpen: deps.finalResultOnly === true,
				onMessage: (message) => {
					const delta = textDeltaOf(message);
					if (delta === null || delta === '') return;
					// LangChain surfaces these as on_chat_model_stream events, which is what n8n's
					// processEventStream feeds to the chat UI (spec F-04). Chained rather than
					// fired-and-forgotten: an async handler that awaits internally could otherwise
					// interleave and deliver tokens out of order, and a rejection with no catch
					// takes the whole worker down as an unhandledRejection.
					tokenQueue = tokenQueue
						.then(() => runManager?.handleLLMNewToken(delta))
						.then(
							() => {},
							(error: unknown) =>
								deps.debug.error('Streaming token handler failed', {
									error: error instanceof Error ? error.message : String(error),
								}),
						);
				},
			});
			// Reported per ATTEMPT, not per _generate: the resume→create retry runs the CLI twice,
			// and reporting only the survivor loses the abandoned attempt's tokens — money that
			// was spent and would never appear in the table. Two attempts, two rows, distinct seq.
			await reportRun({
				usage: deps.usage,
				messages: deps.finalResultOnly ? withFinalResultOnly(sdkMessages) : sdkMessages,
				durationMs: run.durationMs,
				params: runParams,
				appliedEffort: appliedEffort ?? null,
				authMode: deps.auth.mode,
				debug: deps.debug,
			});

			return { run, sdkMessages };
		};

		const logIndex = deps.log?.start({
			messages: messages.map((message) => ({
				type: message._getType(),
				content: message.content,
			})),
			options: this.invocationParams(),
			bridgedTools: bridge?.toolNames ?? [],
			...(sessionUuid ? { sessionUuid } : {}),
		});

		try {
			const session = await runWithSession(runOnce, {
				sessionUuid,
				timeoutSeconds: callParams.timeoutSeconds,
				startedAt,
				debug: deps.debug,
			});
			if (session.unrecoverable) {
				throw new Error(
					`Claude Code could neither resume nor create session ${sessionUuid} ` +
						`(from Session ID "${deps.params.sessionId}"). Check the container's disk and ` +
						'the debug log, or retry without Session ID to run stateless.',
				);
			}
			const sessionState = session.state;

			const { run, sdkMessages } = session.attempt;
			const chat = resolveChatOutcome(
				deps.finalResultOnly ? withFinalResultOnly(sdkMessages) : sdkMessages,
			);

			if (run.timedOut) {
				throw new Error(
					`Claude Code timed out after ${callParams.timeoutSeconds}s` +
						`${chat.sessionId ? ` (session ${chat.sessionId})` : ''}.` +
						(chat.text ? ` Partial answer: ${preview(chat.text)}` : ''),
				);
			}
			if (run.error !== null) {
				throw run.error instanceof Error ? run.error : new Error(String(run.error));
			}

			const usageMetadata = chat.usage
				? {
						input_tokens: chat.usage.inputTokens,
						output_tokens: chat.usage.outputTokens,
						total_tokens: chat.usage.inputTokens + chat.usage.outputTokens,
						input_token_details: {
							cache_read: chat.usage.cacheReadInputTokens,
							cache_creation: chat.usage.cacheCreationInputTokens,
						},
					}
				: undefined;

			const message = new AIMessage({
				// When the structured-output passthrough fires, the tool call IS the answer and the
				// Agent's parser reads only it; the text still travels in the log payload below.
				content: chat.toolCalls.length > 0 ? '' : chat.text,
				tool_calls: chat.toolCalls.map((call) => ({
					id: call.id,
					name: call.name,
					args: call.args,
					type: 'tool_call' as const,
				})),
				usage_metadata: usageMetadata,
				response_metadata: {
					session_id: chat.sessionId,
					session_state: sessionState,
					total_cost_usd: chat.totalCostUsd,
					num_turns: chat.numTurns,
					model: chat.model ?? callParams.model,
					applied_effort: run.appliedEffort,
				},
			});

			if (logIndex !== undefined) {
				deps.log?.end(logIndex, {
					response: chat.text,
					toolCalls: chat.toolCalls,
					// The shape N8nLlmTracing publishes, so the UI's token panel reads it (F-09).
					tokenUsage: chat.usage
						? {
								promptTokens: chat.usage.inputTokens,
								completionTokens: chat.usage.outputTokens,
								totalTokens: chat.usage.inputTokens + chat.usage.outputTokens,
							}
						: undefined,
					totalCostUsd: chat.totalCostUsd,
					sessionId: chat.sessionId,
					sessionState,
				});
			}

			return {
				generations: [{ text: chat.toolCalls.length > 0 ? '' : chat.text, message }],
				llmOutput: {
					tokenUsage: chat.usage
						? {
								promptTokens: chat.usage.inputTokens,
								completionTokens: chat.usage.outputTokens,
								totalTokens: chat.usage.inputTokens + chat.usage.outputTokens,
							}
						: undefined,
					totalCostUsd: chat.totalCostUsd,
					sessionId: chat.sessionId,
				},
			};
		} catch (error) {
			if (logIndex !== undefined) deps.log?.error(logIndex, error);
			throw error;
		} finally {
			listening.detach();
			// Every streamed token has been handed to LangChain before the caller sees a result;
			// otherwise a late delta could arrive after the Agent moved on.
			await tokenQueue;
		}
	}
}
