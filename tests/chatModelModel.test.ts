import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { DebugLogger } from '../nodes/shared/debug';
import type { ClaudeCodeParams } from '../nodes/ClaudeCode/types';
import {
	ClaudeCodeChat,
	toSessionUuid,
	type ChatModelDeps,
} from '../nodes/ClaudeCodeChatModel/model';

/**
 * The model driven end to end through LangChain's own `invoke`, with a scripted `query` — the
 * same seam every other suite uses (DEC-02). What n8n's Agent calls is exactly this surface.
 */

const msg = (value: unknown): SDKMessage => value as SDKMessage;

const script = (messages: SDKMessage[], seen: unknown[] = []): typeof sdkQuery =>
	((input: { options: unknown }) => {
		seen.push(input.options);
		const generator = (async function* () {
			for (const message of messages) yield message;
		})();
		return Object.assign(generator, {
			interrupt: async () => {},
			close: () => {},
		});
	}) as unknown as typeof sdkQuery;

const noopDebug: DebugLogger = {
	enabled: false,
	log: () => {},
	lazy: () => {},
	error: () => {},
};

const params = (over: Partial<ClaudeCodeParams> = {}): ClaudeCodeParams => ({
	operation: 'query',
	sessionId: '',
	prompt: '',
	model: 'claude-sonnet-5',
	effort: 'high',
	maxTurns: 5,
	timeoutSeconds: 300,
	projectPath: '',
	outputFormat: 'text',
	allowedTools: [],
	disallowedTools: [],
	restrictTools: [],
	attachments: {
		all: false,
		names: [],
		inlineTextLimitKb: 256,
		maxAttachmentMb: 50,
		maxAttachmentCount: 16,
		allowedExtensions: [],
	},
	additional: { wrapUpGraceSeconds: 60 },
	nodeVersion: 1,
	itemIndex: 0,
	...over,
});

const deps = (over: Partial<ChatModelDeps> = {}): ChatModelDeps => ({
	params: params(),
	systemPromptMode: 'append',
	auth: { mode: 'host' },
	query: script([]),
	debug: noopDebug,
	processEnv: { PATH: '/usr/bin' },
	...over,
});

const happyRun = [
	msg({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-sonnet-5' }),
	msg({
		type: 'assistant',
		session_id: 's-1',
		message: { content: [{ type: 'text', text: 'pong' }] },
	}),
	msg({
		type: 'result',
		subtype: 'success',
		result: 'pong',
		session_id: 's-1',
		total_cost_usd: 0.01,
		num_turns: 1,
		modelUsage: {
			'claude-sonnet-5': {
				inputTokens: 50,
				outputTokens: 10,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			},
		},
	}),
];

describe('ClaudeCodeChat — the Agent’s gate (F-01)', () => {
	it('lc_namespace includes chat_models and bindTools exists — isChatInstance passes', () => {
		const model = new ClaudeCodeChat(deps());
		assert.ok(model.lc_namespace.includes('chat_models'));
		assert.equal(typeof model.bindTools, 'function');
		assert.equal(model._llmType(), 'claude-code');
	});

	it('bindTools returns a NEW instance carrying the tools; the original is untouched', () => {
		const model = new ClaudeCodeChat(deps());
		const bound = model.bindTools([{ name: 'calculator', invoke: async () => '4' }] as never);
		assert.notEqual(bound, model);
		assert.deepEqual(bound.invocationParams().tools, ['calculator']);
		assert.deepEqual(model.invocationParams().tools, []);
	});
});

describe('ClaudeCodeChat — one _generate is one run', () => {
	it('returns the answer with usage and response metadata', async () => {
		const model = new ClaudeCodeChat(deps({ query: script(happyRun) }));
		const message = await model.invoke([new HumanMessage('ping?')]);

		assert.equal(message.content, 'pong');
		assert.deepEqual(message.usage_metadata, {
			input_tokens: 50,
			output_tokens: 10,
			total_tokens: 60,
			input_token_details: { cache_read: 0, cache_creation: 0 },
		});
		assert.equal(message.response_metadata.session_id, 's-1');
		assert.equal(message.response_metadata.total_cost_usd, 0.01);
		assert.equal(message.response_metadata.model, 'claude-sonnet-5');
	});

	it('append mode: the Agent’s system message lands in the preset append slot', async () => {
		const seen: Array<{ systemPrompt?: unknown }> = [];
		const model = new ClaudeCodeChat(
			deps({ query: script(happyRun, seen), systemPromptMode: 'append' }),
		);
		await model.invoke([new SystemMessage('be terse'), new HumanMessage('hi')]);
		assert.deepEqual(seen[0].systemPrompt, {
			type: 'preset',
			preset: 'claude_code',
			append: 'be terse',
		});
	});

	it('replace mode: the Agent’s system message becomes the whole system prompt', async () => {
		const seen: Array<{ systemPrompt?: unknown }> = [];
		const model = new ClaudeCodeChat(
			deps({ query: script(happyRun, seen), systemPromptMode: 'replace' }),
		);
		await model.invoke([new SystemMessage('you are a poet'), new HumanMessage('hi')]);
		assert.equal(seen[0].systemPrompt, 'you are a poet');
	});

	it('bound tools reach the run as one in-process MCP server, pre-approved', async () => {
		const seen: Array<{ mcpServers?: Record<string, unknown>; allowedTools?: string[] }> = [];
		const model = new ClaudeCodeChat(deps({ query: script(happyRun, seen) })).bindTools([
			{ name: 'calculator', invoke: async () => '4' },
		] as never);
		await model.invoke([new HumanMessage('hi')]);
		assert.deepEqual(Object.keys(seen[0].mcpServers ?? {}), ['n8n']);
		assert.ok(seen[0].allowedTools?.includes('mcp__n8n__calculator'));
	});

	it('a run error rejects the call — the Agent decides what that means', async () => {
		const failing = ((_: unknown) => {
			const generator = (async function* () {
				yield happyRun[0];
				throw new Error('spawn failed');
			})();
			return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
		}) as unknown as typeof sdkQuery;

		const model = new ClaudeCodeChat(deps({ query: failing }));
		await assert.rejects(model.invoke([new HumanMessage('hi')]), /spawn failed/);
	});

	it('the R16 passthrough: a format tool call becomes tool_calls, content empty', async () => {
		const withFormat = [
			happyRun[0],
			msg({
				type: 'assistant',
				session_id: 's-1',
				message: {
					content: [
						{
							type: 'tool_use',
							name: 'mcp__n8n__format_final_json_response',
							id: 'tu-1',
							input: { answer: 42 },
						},
					],
				},
			}),
			happyRun[2],
		];
		const model = new ClaudeCodeChat(deps({ query: script(withFormat) }));
		const message = await model.invoke([new HumanMessage('hi')]);
		assert.equal(message.content, '');
		assert.deepEqual(message.tool_calls, [
			{ id: 'tu-1', name: 'format_final_json_response', args: { answer: 42 }, type: 'tool_call' },
		]);
	});

	it('streams text deltas to the callback manager as they arrive (F-04)', async () => {
		const streaming = [
			happyRun[0],
			msg({
				type: 'stream_event',
				session_id: 's-1',
				parent_tool_use_id: null,
				event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'po' } },
			}),
			msg({
				type: 'stream_event',
				session_id: 's-1',
				parent_tool_use_id: null,
				event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ng' } },
			}),
			// A subagent's delta must NOT surface.
			msg({
				type: 'stream_event',
				session_id: 's-1',
				parent_tool_use_id: 'tu-1',
				event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'XX' } },
			}),
			happyRun[1],
			happyRun[2],
		];
		const tokens: string[] = [];
		const model = new ClaudeCodeChat(deps({ query: script(streaming) }));
		await model.invoke([new HumanMessage('ping?')], {
			callbacks: [{ handleLLMNewToken: (token: string) => void tokens.push(token) }],
		});
		assert.deepEqual(tokens, ['po', 'ng']);
	});

	it('resume: options.resume is set and ONLY the current message travels', async () => {
		const seenOptions: Array<{ resume?: string }> = [];
		const seenPrompts: unknown[] = [];
		const capturing = ((input: {
			prompt: AsyncIterable<{ message?: { content?: unknown } }>;
			options: unknown;
		}) => {
			seenOptions.push(input.options as { resume?: string });
			const generator = (async function* () {
				const first = await input.prompt[Symbol.asyncIterator]().next();
				seenPrompts.push(first.value?.message?.content);
				for (const message of happyRun) yield message;
			})();
			return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
		}) as unknown as typeof sdkQuery;

		const model = new ClaudeCodeChat(
			deps({
				query: capturing,
				params: params({ operation: 'continue', sessionId: 'sess-abc-123' }),
			}),
		);
		await model.invoke([
			new HumanMessage('earlier question'),
			new SystemMessage(''),
			new HumanMessage('current question'),
		]);

		// A non-UUID value is a conversation key: it resumes under its deterministic hash.
		assert.equal(seenOptions[0].resume, toSessionUuid('sess-abc-123'));
		// A plain string with no transcript block: the session already holds the history.
		assert.equal(seenPrompts[0], 'current question');
	});

	it('a stable key is hashed to the SAME deterministic uuid, and resume uses it', async () => {
		const key = 'discord:1234567890';
		assert.equal(toSessionUuid(key), toSessionUuid(key), 'deterministic');
		assert.match(
			toSessionUuid(key),
			/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		assert.notEqual(toSessionUuid(key), toSessionUuid('discord:other'));
		// A value that already is a UUID passes through untouched (lowercased).
		assert.equal(
			toSessionUuid('AAAAAAAA-0000-4000-8000-000000000001'),
			'aaaaaaaa-0000-4000-8000-000000000001',
		);

		const seen: Array<{ resume?: string }> = [];
		const model = new ClaudeCodeChat(
			deps({
				query: script(happyRun, seen),
				params: params({ operation: 'continue', sessionId: key }),
			}),
		);
		await model.invoke([new HumanMessage('hi')]);
		assert.equal(seen[0].resume, toSessionUuid(key));
	});

	it('first message of a conversation: resume finds nothing, the session is CREATED under the same id', async () => {
		// The rejection shape, as the runner actually reports it (measured on case65c): the
		// generator throws "No conversation found with session ID: …" after the error result.
		const seen: Array<{ resume?: string; sessionId?: string }> = [];
		let call = 0;
		const twoPhase = ((input: { options: unknown }) => {
			seen.push(input.options as never);
			const first = call++ === 0;
			const generator = (async function* () {
				if (first) {
					yield happyRun[0];
					yield msg({ type: 'result', subtype: 'error_during_execution', session_id: 'x' });
					throw new Error('No conversation found with session ID: x');
				}
				for (const message of happyRun) yield message;
			})();
			return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
		}) as unknown as typeof sdkQuery;

		const model = new ClaudeCodeChat(
			deps({ query: twoPhase, params: params({ operation: 'continue', sessionId: 'my-key' }) }),
		);
		const message = await model.invoke([new HumanMessage('hi')]);

		const uuid = toSessionUuid('my-key');
		assert.equal(seen.length, 2, 'one resume attempt, one create attempt');
		assert.equal(seen[0].resume, uuid);
		assert.equal(seen[1].resume, undefined);
		assert.equal(seen[1].sessionId, uuid, 'created under the SAME deterministic id');
		assert.equal(message.content, 'pong');
		assert.equal(message.response_metadata.session_state, 'created');
	});

	it('the SILENT not-found shape also creates the session (the shape the spike first saw)', async () => {
		// error_during_execution with zero assistant turns AND num_turns 0 — narrowed so a generic
		// first-turn failure (auth refusal, CLI crash) does not bill a second pointless run.
		const silent = [
			happyRun[0],
			msg({ type: 'result', subtype: 'error_during_execution', session_id: 'x', num_turns: 0 }),
		];
		const seen: Array<{ resume?: string; sessionId?: string }> = [];
		let call = 0;
		const twoPhase = ((input: { options: unknown }) => {
			seen.push(input.options as never);
			const script_ = call++ === 0 ? silent : happyRun;
			const generator = (async function* () {
				for (const message of script_) yield message;
			})();
			return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
		}) as unknown as typeof sdkQuery;

		const model = new ClaudeCodeChat(
			deps({ query: twoPhase, params: params({ operation: 'continue', sessionId: 'k' }) }),
		);
		const message = await model.invoke([new HumanMessage('hi')]);
		assert.equal(seen.length, 2);
		assert.equal(seen[1].sessionId, toSessionUuid('k'), 'created under the same deterministic id');
		assert.equal(message.response_metadata.session_state, 'created');
	});

	it('a resume that merely TIMED OUT is not retried as a missing session', async () => {
		// The retry must not fire on a timeout: it would double the spend and then blame the
		// container's disk for something that was only slow.
		const seen: unknown[] = [];
		const hanging = ((input: { options: { abortController: AbortController } }) => {
			seen.push(input.options);
			const generator = (async function* () {
				yield happyRun[0];
				await new Promise<void>((resolve) =>
					input.options.abortController.signal.addEventListener('abort', () => resolve(), {
						once: true,
					}),
				);
			})();
			return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
		}) as unknown as typeof sdkQuery;

		const model = new ClaudeCodeChat(
			deps({
				query: hanging,
				params: params({
					operation: 'continue',
					sessionId: 'k',
					timeoutSeconds: 1,
					additional: { wrapUpGraceSeconds: 0 },
				}),
			}),
		);
		await assert.rejects(model.invoke([new HumanMessage('hi')]), /timed out/);
		assert.equal(seen.length, 1, 'exactly one attempt');
	});

	it('when even creating fails, the run fails loud — never a fabricated answer', async () => {
		const notFound = [
			happyRun[0],
			msg({ type: 'result', subtype: 'error_during_execution', session_id: 'x' }),
		];
		const model = new ClaudeCodeChat(
			deps({
				query: script(notFound),
				params: params({ operation: 'continue', sessionId: 'my-key' }),
			}),
		);
		await assert.rejects(model.invoke([new HumanMessage('hi')]), /could neither resume nor create/);
	});

	it('a successful resume answers normally and reports session_state resumed', async () => {
		const model = new ClaudeCodeChat(
			deps({
				query: script(happyRun),
				params: params({ operation: 'continue', sessionId: 's-1-key' }),
			}),
		);
		const message = await model.invoke([new HumanMessage('hi')]);
		assert.equal(message.content, 'pong');
		assert.equal(message.response_metadata.session_state, 'resumed');
	});

	it('a config problem rejects before anything is spawned', async () => {
		const spawned: unknown[] = [];
		const model = new ClaudeCodeChat(
			deps({
				query: script(happyRun, spawned),
				params: params({ model: 'sonnet', additional: { fallbackModel: 'sonnet' } }),
			}),
		);
		await assert.rejects(model.invoke([new HumanMessage('hi')]), /Fallback Model/);
		assert.equal(spawned.length, 0);
	});
});
