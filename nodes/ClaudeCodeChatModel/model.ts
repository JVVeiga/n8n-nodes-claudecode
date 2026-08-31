import { createHash } from 'node:crypto';
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
import { assistantMessages, findResult } from '../shared/sdkMessage';
import { attachAbort } from '../shared/abort';
import { preview } from '../shared/preview';
import { buildQueryOptions } from '../ClaudeCode/config';
import { createPromptStream } from '../ClaudeCode/promptStream';
import { runQuery } from '../ClaudeCode/runner';
import type { ClaudeCodeParams } from '../ClaudeCode/types';
import { mapMessages } from './messages';
import { resolveChatOutcome } from './result';
import { buildToolBridge, type BindableTool } from './toolBridge';
import { reportRun, type UsageReporting } from '../shared/usageReport';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Session ID parameter accepts either a real session UUID (the round-trip style) or ANY
 * stable conversation key — `discord:8463…`, a phone number, a ticket id. A key is hashed into a
 * deterministic UUID (v5-shaped: SHA-1, version and variant bits set), because the SDK requires
 * a valid UUID and because determinism is the whole point: the same key always names the same
 * session, so nothing anywhere has to store a mapping.
 */
export function toSessionUuid(sessionIdOrKey: string): string {
	if (UUID_RE.test(sessionIdOrKey)) return sessionIdOrKey.toLowerCase();
	const hash = createHash('sha1')
		.update('n8n-nodes-claudecode/chat-model-session/')
		.update(sessionIdOrKey)
		.digest('hex');
	const bytes = hash.slice(0, 32).split('');
	bytes[12] = '5'; // version 5
	bytes[16] = ((parseInt(bytes[16], 16) & 0x3) | 0x8).toString(16); // RFC 4122 variant
	const h = bytes.join('');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

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

		/** One CLI run. `resume` continues an existing session; `create` starts one under the
		 * deterministic id (the SDK's `sessionId` option); null is a plain anonymous session. */
		const runOnce = async (session: { resume: string } | { create: string } | null) => {
			const promptStream = createPromptStream(mapped.prompt);
			// The retry must not spend the configured timeout twice: runQuery arms its timers from
			// the start of EACH run, so a 300s node could occupy 600s of wall clock. The second
			// attempt gets what is left of the budget, floored at 5s so it is never born expired.
			const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
			const budgeted: ClaudeCodeParams = {
				...callParams,
				timeoutSeconds: Math.max(5, callParams.timeoutSeconds - elapsedSeconds),
			};
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
				messages: sdkMessages,
				durationMs: run.durationMs,
				params: runParams,
				appliedEffort: appliedEffort ?? null,
				authMode: deps.auth.mode,
				debug: deps.debug,
			});

			return { run, sdkMessages };
		};

		/** True when an attempt hit the session-not-found outcome. Measured twice, because it has
		 * TWO shapes: the generator rejects with "No conversation found with session ID: …"
		 * (what the runner reports as `run.error` — seen on case65c), and, when the stream is
		 * abandoned before the rejection lands, a silent `error_during_execution` result with
		 * zero assistant turns (the original spike, which broke out of the loop early and
		 * therefore only saw this one). */
		const resumeFoundNothing = (attempt: {
			run: { error: unknown; timedOut: boolean };
			sdkMessages: SDKMessage[];
		}) => {
			if (attempt.run.timedOut) return false;
			if (attempt.run.error !== null) {
				const text =
					attempt.run.error instanceof Error
						? attempt.run.error.message
						: String(attempt.run.error);
				return /No conversation found with session ID/i.test(text);
			}
			// The silent shape: an error result with no assistant turn at all. Narrowed with
			// `num_turns` because any early failure — an auth refusal, a CLI crash — wears the same
			// subtype, and treating those as "session missing" bills a second pointless run and
			// then blames the container's disk for something else entirely.
			const result = findResult(attempt.sdkMessages) as
				| { subtype?: string; num_turns?: number }
				| undefined;
			return (
				assistantMessages(attempt.sdkMessages).length === 0 &&
				result?.subtype === 'error_during_execution' &&
				(result.num_turns ?? 0) === 0
			);
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

		let sessionState: 'new' | 'resumed' | 'created' = sessionUuid ? 'resumed' : 'new';
		try {
			let attempt = await runOnce(sessionUuid ? { resume: sessionUuid } : null);

			// First message of a conversation: the deterministic id names a session that does not
			// exist yet. Create it under that SAME id and run again — this is what makes a stable
			// conversation key work with no storage anywhere (no Data Table, no client state).
			if (sessionUuid && resumeFoundNothing(attempt)) {
				deps.debug.log('Session not found — creating it under the deterministic id', {
					sessionUuid,
				});
				sessionState = 'created';
				attempt = await runOnce({ create: sessionUuid });
				if (resumeFoundNothing(attempt)) {
					throw new Error(
						`Claude Code could neither resume nor create session ${sessionUuid} ` +
							`(from Session ID "${deps.params.sessionId}"). Check the container's disk and ` +
							'the debug log, or retry without Session ID to run stateless.',
					);
				}
			}

			const { run, sdkMessages } = attempt;
			const chat = resolveChatOutcome(sdkMessages);

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
