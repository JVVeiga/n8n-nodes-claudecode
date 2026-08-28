import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Narrowing helpers over the SDK's message union.
 *
 * The node file reached into messages with about twenty-five `as any` casts —
 * `(m as any).subtype`, `(m as any).message?.content`, `resultMsg?.modelUsage`. That threw away
 * the discriminated union, so a field the SDK renames would compile fine and silently read
 * undefined at runtime. timeout.ts already narrowed properly; these are its guards, lifted so
 * everything else can use them too.
 *
 * The casts that remain are confined to `contentOf`, where the SDK types content blocks loosely
 * enough that a structural type is the honest description.
 */

export type ResultMessage = Extract<SDKMessage, { type: 'result' }>;
export type AssistantMessage = Extract<SDKMessage, { type: 'assistant' }>;
export type UserMessage = Extract<SDKMessage, { type: 'user' }>;
export type InitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;

export const isResult = (m: SDKMessage): m is ResultMessage => m.type === 'result';
export const isAssistant = (m: SDKMessage): m is AssistantMessage => m.type === 'assistant';
export const isUser = (m: SDKMessage): m is UserMessage => m.type === 'user';
export const isInit = (m: SDKMessage): m is InitMessage =>
	m.type === 'system' && m.subtype === 'init';

/** A content block, described structurally: the SDK's own block union is wider than any one
 * consumer needs, and every field here is optional in at least one variant. */
export type ContentBlock = { type?: string; name?: string; text?: string; thinking?: string };

export const contentOf = (m: AssistantMessage): ContentBlock[] => {
	const content = m.message?.content;
	return Array.isArray(content) ? (content as ContentBlock[]) : [];
};

/**
 * The FIRST init message, deliberately. A graceful timeout re-inits the session after the
 * interrupt, so there can be two; the first is the authoritative record of the session that was
 * actually started, and the model it resolved to.
 */
export const findInit = (messages: SDKMessage[]): InitMessage | undefined => messages.find(isInit);

/** The FIRST result message — what the pre-refactor node read for its diagnostics and metrics. */
export const findResult = (messages: SDKMessage[]): ResultMessage | undefined =>
	messages.find(isResult);

/** The LAST result message. A graceful timeout emits two, and the second carries the cumulative
 * spend plus the wrap-up text. */
export const lastResult = (messages: SDKMessage[]): ResultMessage | undefined => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (isResult(m)) return m;
	}
	return undefined;
};

export const assistantMessages = (messages: SDKMessage[]): AssistantMessage[] =>
	messages.filter(isAssistant);

/** Text of the last assistant message that has any — the transcript fallback when no result
 * message carries text. */
export const lastAssistantText = (messages: SDKMessage[]): string | null => {
	const assistants = assistantMessages(messages);
	for (let i = assistants.length - 1; i >= 0; i--) {
		const text = contentOf(assistants[i]).find((c) => c.type === 'text')?.text;
		if (typeof text === 'string' && text !== '') return text;
	}
	return null;
};

/** Counts content blocks across every assistant message. Used for the tool-use and thinking
 * tallies in diagnostics. */
export const countContent = (
	messages: SDKMessage[],
	predicate: (block: ContentBlock) => boolean,
): number =>
	assistantMessages(messages).reduce(
		(total, m) => total + contentOf(m).filter(predicate).length,
		0,
	);

export const countToolUses = (messages: SDKMessage[], name: string): number =>
	countContent(messages, (c) => c.type === 'tool_use' && c.name === name);
