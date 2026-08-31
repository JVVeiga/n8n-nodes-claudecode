import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { BaseMessage } from '@langchain/core/messages';
import type { PromptContent } from '../ClaudeCode/promptStream';

/**
 * The Agent hands the model a `BaseMessage[]`: an optional SystemMessage, the memory's history
 * (Human/AI, possibly AI-with-tool-calls plus ToolMessages), and the current Human input last.
 * The SDK's `query()` takes one user turn — prior assistant turns cannot be injected (its
 * multi-turn story is sessions, which have no key to live under across Agent calls). So history
 * is flattened into a transcript block that precedes the question, per DEC-15's
 * content-before-question rule. Pure module; the tests drive it with hand-built messages.
 */

export type MappedPrompt = {
	/** The system messages' text, joined. Undefined when there were none — the caller decides
	 * whether that means "append nothing" or "replace with nothing". */
	system: string | undefined;
	prompt: PromptContent;
};

/** What a turn carrying no text at all becomes. The API refuses an empty text block, so the
 * absence has to be said in words. */
export const EMPTY_INPUT = '(no input)';

export type MapOptions = {
	/**
	 * `flatten` (default) narrates prior turns into a transcript block. `omit` drops them: used
	 * when the run RESUMES a Claude Code session, which already holds the real conversation —
	 * sending the flattened copy too would put every prior turn in the context twice.
	 */
	history?: 'flatten' | 'omit';
};

type RawBlock = {
	type?: string;
	text?: string;
	image_url?: string | { url?: string };
	source_type?: string;
	url?: string;
	data?: string;
	mime_type?: string;
};

/** The text carried by a message's content, whether it is a string or a block array. */
const textOf = (content: unknown): string => {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return (content as RawBlock[])
		.filter((block) => block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n');
};

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s;

/**
 * LangChain image blocks → Anthropic image blocks. Two shapes arrive in practice: OpenAI-style
 * `image_url` (string or `{url}`, possibly a data: URI) and LangChain's standard content block
 * (`source_type: 'base64' | 'url'`). Anything unrecognised is dropped rather than guessed at —
 * a wrong media type is a 400 for the whole run.
 */
const imageBlocksOf = (content: unknown): ContentBlockParam[] => {
	if (!Array.isArray(content)) return [];
	const blocks: ContentBlockParam[] = [];
	for (const block of content as RawBlock[]) {
		if (block.type === 'image_url') {
			const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
			if (!url) continue;
			const dataUri = DATA_URI.exec(url);
			blocks.push(
				dataUri
					? {
							type: 'image',
							source: { type: 'base64', media_type: dataUri[1] as never, data: dataUri[2] },
						}
					: { type: 'image', source: { type: 'url', url } },
			);
		} else if (block.type === 'image' && block.source_type === 'base64' && block.data) {
			blocks.push({
				type: 'image',
				source: {
					type: 'base64',
					media_type: (block.mime_type ?? 'image/png') as never,
					data: block.data,
				},
			});
		} else if (block.type === 'image' && block.source_type === 'url' && block.url) {
			blocks.push({ type: 'image', source: { type: 'url', url: block.url } });
		}
	}
	return blocks;
};

/** `_getType()` rather than instanceof: the messages may come from n8n's copy of
 * `@langchain/core`, and the duck check is the one LangChain itself uses (`isBaseMessage`). */
const typeOf = (message: BaseMessage): string => message._getType();

type ToolCallLike = { name?: string; args?: unknown };

const transcriptLine = (message: BaseMessage): string[] => {
	const kind = typeOf(message);
	const text = textOf(message.content);
	if (kind === 'human') {
		const imageNote = imageBlocksOf(message.content).length > 0 ? ' [sent an image]' : '';
		return [`User:${imageNote} ${text}`.trimEnd()];
	}
	if (kind === 'ai') {
		const lines: string[] = [];
		const toolCalls = (message as unknown as { tool_calls?: ToolCallLike[] }).tool_calls ?? [];
		for (const call of toolCalls) {
			lines.push(`Assistant called tool ${call.name ?? 'unknown'}(${JSON.stringify(call.args)})`);
		}
		if (text !== '') lines.push(`Assistant: ${text}`);
		return lines;
	}
	if (kind === 'tool') {
		const name = (message as unknown as { name?: string }).name;
		return [`Tool result${name ? ` (${name})` : ''}: ${text}`];
	}
	// generic/function/anything future: keep the text rather than lose a turn silently.
	return text === '' ? [] : [`${kind}: ${text}`];
};

export function mapMessages(messages: BaseMessage[], options: MapOptions = {}): MappedPrompt {
	const systemTexts: string[] = [];
	const conversation: BaseMessage[] = [];
	for (const message of messages) {
		if (typeOf(message) === 'system') {
			const text = textOf(message.content);
			if (text !== '') systemTexts.push(text);
		} else {
			conversation.push(message);
		}
	}

	// The question is the LAST human message; everything else is context. The Agent puts the
	// current input last, but a scratchpad turn could in principle follow it — treating whatever
	// trails the last human turn as history keeps that case honest too.
	let lastHumanIndex = -1;
	for (let i = conversation.length - 1; i >= 0; i--) {
		if (typeOf(conversation[i]) === 'human') {
			lastHumanIndex = i;
			break;
		}
	}

	const current = lastHumanIndex >= 0 ? conversation[lastHumanIndex] : undefined;
	const history =
		options.history === 'omit' ? [] : conversation.filter((_, index) => index !== lastHumanIndex);

	const transcript = history.flatMap(transcriptLine).join('\n');
	const currentText = current ? textOf(current.content) : '';
	const images = current ? imageBlocksOf(current.content) : [];

	const system = systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined;

	if (transcript === '' && images.length === 0) {
		// Never an empty turn: the API rejects a request whose only text block is empty, and a
		// bare '' would reach it through createPromptStream unchanged.
		return { system, prompt: currentText === '' ? EMPTY_INPUT : currentText };
	}

	// Content before the question (DEC-15): transcript, then images, then what is being asked.
	const blocks: ContentBlockParam[] = [];
	if (transcript !== '') {
		blocks.push({
			type: 'text',
			text: `Previous conversation, for context:\n\n${transcript}`,
		});
	}
	blocks.push(...images);
	// Only when there IS something to ask. An image-only turn is the common case — Anthropic
	// rejects `{type:'text', text:''}` with a 400 that fails the whole run, so the block is
	// omitted rather than sent empty. When nothing else survived, say so in words instead.
	if (currentText !== '') {
		blocks.push({ type: 'text', text: currentText });
	} else if (images.length === 0) {
		blocks.push({ type: 'text', text: EMPTY_INPUT });
	}
	return { system, prompt: blocks };
}
