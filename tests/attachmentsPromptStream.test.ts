import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { createPromptStream } from '../nodes/ClaudeCode/promptStream';

/**
 * Content blocks through the prompt stream. The rest of the stream's behaviour — queueing, closing,
 * draining — is covered in promptStream.test.ts and is unchanged by this feature.
 */

const drain = async (stream: AsyncIterable<{ message: { content: unknown } }>) => {
	const out: unknown[] = [];
	for await (const message of stream) out.push(message.message.content);
	return out;
};

const blocks: ContentBlockParam[] = [
	{
		type: 'document',
		title: 'a.csv',
		source: { type: 'text', media_type: 'text/plain', data: 'x' },
	},
	{ type: 'text', text: 'what is in it?' },
];

describe('createPromptStream — content blocks', () => {
	it('passes a block array through as message.content, verbatim', async () => {
		const stream = createPromptStream(blocks);
		stream.close();
		const turns = await drain(stream.stream);
		assert.equal(turns.length, 1);
		assert.deepEqual(turns[0], blocks);
	});

	it('shapes the user message the way the SDK expects', async () => {
		const stream = createPromptStream(blocks);
		stream.close();
		const messages = [];
		for await (const m of stream.stream) messages.push(m);
		assert.deepEqual(
			{
				type: messages[0].type,
				role: messages[0].message.role,
				parent: messages[0].parent_tool_use_id,
			},
			{ type: 'user', role: 'user', parent: null },
		);
	});

	it('still takes a plain string — a run with no attachments is unchanged', async () => {
		const stream = createPromptStream('hello');
		stream.close();
		assert.deepEqual(await drain(stream.stream), ['hello']);
	});

	it('still opens with no turn at all when given nothing', async () => {
		const stream = createPromptStream();
		stream.close();
		assert.deepEqual(await drain(stream.stream), []);
	});

	it('accepts an empty block array as a turn — the node never builds one, but the type allows it', async () => {
		const stream = createPromptStream([]);
		stream.close();
		assert.deepEqual(await drain(stream.stream), [[]]);
	});

	it('pushes a text follow-up after a block-array opening turn', async () => {
		const stream = createPromptStream(blocks);
		stream.push('wrap up');
		stream.close();
		const turns = await drain(stream.stream);
		assert.deepEqual(turns, [blocks, 'wrap up']);
	});
});
