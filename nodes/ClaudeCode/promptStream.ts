import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

/**
 * The prompt as a stream rather than a string, because `interrupt()` and the other control requests
 * only work in streaming input mode. The SDK keeps the session open for as long as the input stream
 * is, so a stream that never closes is a query that never finishes — the caller must close it.
 */

/**
 * A turn is either text or a block array. `SDKUserMessage.message` is the Anthropic SDK's
 * `MessageParam` (`sdk.d.ts:4294`), whose `content` accepts `ContentBlockParam[]` — which is how an
 * image, a PDF or a document reaches the model directly, with no filesystem and no Read tool.
 * Verified end to end before this was built; the spikes are in the feature's spec folder.
 */
export type PromptContent = string | ContentBlockParam[];

export type PromptStream = {
	stream: AsyncIterable<SDKUserMessage>;
	/** Queue a follow-up user turn. Ignored once the stream is closed. Text only: the sole caller
	 * is the timeout wrap-up, which is a sentence and always will be. */
	push: (text: string) => void;
	/** Let the generator finish, which in turn lets the query end. Idempotent. */
	close: () => void;
};

const toUserMessage = (content: PromptContent): SDKUserMessage => ({
	type: 'user',
	message: { role: 'user', content },
	parent_tool_use_id: null,
});

/**
 * With no initial prompt the stream opens a session without a user turn: the control requests
 * (usage, initialize) answer on an idle session, so reading account and plan data costs nothing.
 * The caller still has to close it, otherwise the query never ends.
 */
export function createPromptStream(initialPrompt?: PromptContent): PromptStream {
	const queued: string[] = [];
	let closed = false;
	let wake: (() => void) | null = null;

	const notify = () => {
		const pending = wake;
		wake = null;
		if (pending) pending();
	};

	async function* generate(): AsyncGenerator<SDKUserMessage> {
		if (initialPrompt !== undefined) yield toUserMessage(initialPrompt);

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
