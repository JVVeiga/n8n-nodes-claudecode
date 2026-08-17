import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createPromptStream } from '../nodes/ClaudeCode/promptStream';

const textOf = (m: SDKUserMessage): string => String(m.message.content);

/** Consumes the stream to completion. Rejects rather than hanging forever if close() never lands,
 * which is the failure mode that would otherwise wedge a real node execution. */
async function drain(stream: AsyncIterable<SDKUserMessage>, timeoutMs = 1000): Promise<string[]> {
	const collected: string[] = [];
	const consume = (async () => {
		for await (const message of stream) {
			collected.push(textOf(message));
		}
	})();

	let timer: NodeJS.Timeout | undefined;
	const guard = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error('stream did not terminate')), timeoutMs);
	});

	try {
		await Promise.race([consume, guard]);
	} finally {
		if (timer) clearTimeout(timer);
	}

	return collected;
}

describe('createPromptStream', () => {
	it('yields the initial prompt first', async () => {
		const ctrl = createPromptStream('do the thing');
		const iterator = ctrl.stream[Symbol.asyncIterator]();

		const first = await iterator.next();

		assert.equal(first.done, false);
		assert.equal(textOf(first.value as SDKUserMessage), 'do the thing');
	});

	it('terminates once closed, so the query can end', async () => {
		const ctrl = createPromptStream('initial');
		ctrl.close();

		assert.deepEqual(await drain(ctrl.stream), ['initial']);
	});

	it('delivers a follow-up turn pushed while the generator is blocked', async () => {
		const ctrl = createPromptStream('initial');
		const collected: string[] = [];

		const consume = (async () => {
			for await (const message of ctrl.stream) {
				collected.push(textOf(message));
				if (collected.length === 2) ctrl.close();
			}
		})();

		// Let the generator reach its blocked state before the push, which is the real ordering:
		// the wrap-up is pushed long after the initial prompt was consumed.
		await new Promise((resolve) => setImmediate(resolve));
		ctrl.push('wrap up now');
		await consume;

		assert.deepEqual(collected, ['initial', 'wrap up now']);
	});

	it('delivers a message pushed in the same tick as the close', async () => {
		const ctrl = createPromptStream('initial');
		ctrl.push('wrap up now');
		ctrl.close();

		assert.deepEqual(await drain(ctrl.stream), ['initial', 'wrap up now']);
	});

	it('ignores a push after the close', async () => {
		const ctrl = createPromptStream('initial');
		ctrl.close();
		ctrl.push('too late');

		assert.deepEqual(await drain(ctrl.stream), ['initial']);
	});

	it('tolerates a repeated close', async () => {
		const ctrl = createPromptStream('initial');
		ctrl.close();
		ctrl.close();

		assert.deepEqual(await drain(ctrl.stream), ['initial']);
	});

	it('sends a shape the SDK accepts as a user turn', async () => {
		const ctrl = createPromptStream('initial');
		const iterator = ctrl.stream[Symbol.asyncIterator]();

		const { value } = await iterator.next();
		const message = value as SDKUserMessage;

		assert.equal(message.type, 'user');
		assert.equal(message.parent_tool_use_id, null);
		assert.equal(message.message.role, 'user');
	});
});
