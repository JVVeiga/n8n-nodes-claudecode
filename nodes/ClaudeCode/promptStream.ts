import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * The prompt as a stream rather than a string, because `interrupt()` and the other control requests
 * only work in streaming input mode. The SDK keeps the session open for as long as the input stream
 * is, so a stream that never closes is a query that never finishes — the caller must close it.
 */
export type PromptStream = {
	stream: AsyncIterable<SDKUserMessage>;
	/** Queue a follow-up user turn. Ignored once the stream is closed. */
	push: (text: string) => void;
	/** Let the generator finish, which in turn lets the query end. Idempotent. */
	close: () => void;
};

const toUserMessage = (text: string): SDKUserMessage => ({
	type: 'user',
	message: { role: 'user', content: text },
	parent_tool_use_id: null,
});

export function createPromptStream(initialPrompt: string): PromptStream {
	const queued: string[] = [];
	let closed = false;
	let wake: (() => void) | null = null;

	const notify = () => {
		const pending = wake;
		wake = null;
		if (pending) pending();
	};

	async function* generate(): AsyncGenerator<SDKUserMessage> {
		yield toUserMessage(initialPrompt);

		// Drain before honouring the close, so a message pushed in the same tick as the close is
		// still delivered rather than silently dropped.
		while (!closed || queued.length > 0) {
			const next = queued.shift();
			if (next !== undefined) {
				yield toUserMessage(next);
				continue;
			}
			if (closed) break;
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
	}

	return {
		stream: generate(),
		push: (text: string) => {
			if (closed) return;
			queued.push(text);
			notify();
		},
		close: () => {
			closed = true;
			notify();
		},
	};
}
