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
export type TaskStartedMessage = Extract<SDKMessage, { type: 'system'; subtype: 'task_started' }>;
export type TaskNotificationMessage = Extract<
	SDKMessage,
	{ type: 'system'; subtype: 'task_notification' }
>;

export const isResult = (m: SDKMessage): m is ResultMessage => m.type === 'result';
export const isAssistant = (m: SDKMessage): m is AssistantMessage => m.type === 'assistant';
export const isUser = (m: SDKMessage): m is UserMessage => m.type === 'user';
export const isInit = (m: SDKMessage): m is InitMessage =>
	m.type === 'system' && m.subtype === 'init';
export const isTaskStarted = (m: SDKMessage): m is TaskStartedMessage =>
	m.type === 'system' && m.subtype === 'task_started';
export const isTaskNotification = (m: SDKMessage): m is TaskNotificationMessage =>
	m.type === 'system' && m.subtype === 'task_notification';

export type SessionStateMessage = Extract<
	SDKMessage,
	{ type: 'system'; subtype: 'session_state_changed' }
>;
export const isSessionState = (m: SDKMessage): m is SessionStateMessage =>
	m.type === 'system' && m.subtype === 'session_state_changed';

/** True while a subagent that started has not reported back. Tasks without a `subagent_type`
 * (background shells) are left out: one that never ends must not hold a run open. */
export function hasPendingSubagentTask(messages: SDKMessage[]): boolean {
	const pending = new Set<string>();
	for (const m of messages) {
		if (isTaskStarted(m) && typeof m.subagent_type === 'string') pending.add(m.task_id);
		else if (isTaskNotification(m)) pending.delete(m.task_id);
	}
	return pending.size > 0;
}

/** A content block, described structurally: the SDK's own block union is wider than any one
 * consumer needs, and every field here is optional in at least one variant. */
export type ContentBlock = {
	type?: string;
	id?: string;
	name?: string;
	text?: string;
	thinking?: string;
};

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

/**
 * The messages with every result but the last removed. A subagent sent to the background makes
 * the CLI write a result for the turn that launched it ("I'll wait for it") and another for each
 * turn its notification starts; the answer is the last one.
 */
export const withFinalResultOnly = (messages: SDKMessage[]): SDKMessage[] => {
	const final = lastResult(messages);
	return final ? messages.filter((m) => !isResult(m) || m === final) : messages;
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

/** The CLI invokes subagents through a tool named `Agent` while listing it as `Task` in init. */
export const countSubagentToolUses = (messages: SDKMessage[]): number =>
	countContent(messages, (c) => c.type === 'tool_use' && (c.name === 'Agent' || c.name === 'Task'));

/** A block of a user turn, described structurally for the same reason as `ContentBlock`. */
type UserBlock = { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };

const userContentOf = (m: UserMessage): UserBlock[] => {
	const content = m.message?.content;
	return Array.isArray(content) ? (content as UserBlock[]) : [];
};

/** A tool result's content is a string or a list of blocks; only the text blocks carry words. */
const toolResultText = (content: unknown): string => {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((block: { type?: string; text?: unknown }) =>
			block?.type === 'text' && typeof block.text === 'string' ? block.text : '',
		)
		.filter((text) => text !== '')
		.join('\n');
};

export type ToolCall = {
	/** Index of the assistant message that made the call. */
	position: number;
	/** Null while no result with its `tool_use_id` has come back. */
	outcome: { isError: boolean; text: string } | null;
};

/** Every call of the named tool, in order, paired by `tool_use_id` with the result it got. */
export function toolCalls(messages: SDKMessage[], name: string): ToolCall[] {
	const results = new Map<string, { isError: boolean; text: string }>();
	for (const m of messages) {
		if (!isUser(m)) continue;
		for (const block of userContentOf(m)) {
			if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
			results.set(block.tool_use_id, {
				isError: block.is_error === true,
				text: toolResultText(block.content),
			});
		}
	}

	const calls: ToolCall[] = [];
	messages.forEach((m, position) => {
		if (!isAssistant(m)) return;
		for (const block of contentOf(m)) {
			if (block.type !== 'tool_use' || block.name !== name) continue;
			const outcome = typeof block.id === 'string' ? (results.get(block.id) ?? null) : null;
			calls.push({ position, outcome });
		}
	});
	return calls;
}
