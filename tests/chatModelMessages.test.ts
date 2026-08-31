import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { EMPTY_INPUT, mapMessages } from '../nodes/ClaudeCodeChatModel/messages';

/**
 * The Agent hands the model BaseMessage[]; the mapper flattens it into one user turn (R4).
 * These tests build messages with OUR @langchain/core — at runtime they come from n8n's copy,
 * which is why the mapper reads them through `_getType()` and plain fields only.
 */

const blocksOf = (prompt: string | unknown[]): Array<{ type?: string; text?: string }> => {
	assert.ok(Array.isArray(prompt), 'expected a block-array prompt');
	return prompt as Array<{ type?: string; text?: string }>;
};

describe('mapMessages — the plain cases', () => {
	it('a single human message stays a plain string prompt', () => {
		const mapped = mapMessages([new HumanMessage('hi there')]);
		assert.equal(mapped.prompt, 'hi there');
		assert.equal(mapped.system, undefined);
	});

	it('system messages become `system`, joined, and never appear in the prompt', () => {
		const mapped = mapMessages([
			new SystemMessage('be terse'),
			new SystemMessage('answer in French'),
			new HumanMessage('hi'),
		]);
		assert.equal(mapped.system, 'be terse\n\nanswer in French');
		assert.equal(mapped.prompt, 'hi');
	});

	it('no messages at all still says something — an empty turn is a 400', () => {
		// The API rejects a request whose only text block is empty, so the absence has to be put
		// into words rather than sent as ''.
		const mapped = mapMessages([]);
		assert.equal(mapped.prompt, EMPTY_INPUT);
		assert.equal(mapped.system, undefined);
	});

	it('an IMAGE-ONLY turn sends no empty text block (would 400 the whole run)', () => {
		const png = Buffer.from('x').toString('base64');
		const mapped = mapMessages([
			new HumanMessage({
				content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }],
			}),
		]);
		const blocks = blocksOf(mapped.prompt);
		assert.equal(blocks.length, 1, 'the image alone');
		assert.equal(blocks[0].type, 'image');
		assert.ok(
			!blocks.some((b) => b.type === 'text' && b.text === ''),
			'no empty text block anywhere',
		);
	});

	it('history with an empty current input keeps the transcript and says (no input)', () => {
		const mapped = mapMessages([
			new HumanMessage('earlier'),
			new AIMessage('noted'),
			new HumanMessage(''),
		]);
		const blocks = blocksOf(mapped.prompt);
		assert.match(blocks[0].text ?? '', /Previous conversation/);
		assert.equal(blocks[blocks.length - 1].text, EMPTY_INPUT);
	});
});

describe('mapMessages — history flattening (R4)', () => {
	it('prior turns become a transcript block, question last (DEC-15)', () => {
		const mapped = mapMessages([
			new HumanMessage('what is 2+2?'),
			new AIMessage('4'),
			new HumanMessage('and doubled?'),
		]);
		const blocks = blocksOf(mapped.prompt);
		assert.equal(blocks.length, 2);
		assert.match(blocks[0].text ?? '', /Previous conversation/);
		assert.match(blocks[0].text ?? '', /User: what is 2\+2\?/);
		assert.match(blocks[0].text ?? '', /Assistant: 4/);
		assert.equal(blocks[1].text, 'and doubled?');
	});

	it('tool turns are narrated: the call with its args, then the result', () => {
		const withCall = new AIMessage({
			content: '',
			tool_calls: [{ id: 'c1', name: 'calculator', args: { input: '2+2' }, type: 'tool_call' }],
		});
		const mapped = mapMessages([
			new HumanMessage('use the tool'),
			withCall,
			new ToolMessage({ content: '4', tool_call_id: 'c1', name: 'calculator' }),
			new HumanMessage('so?'),
		]);
		const transcript = blocksOf(mapped.prompt)[0].text ?? '';
		assert.match(transcript, /Assistant called tool calculator\(\{"input":"2\+2"\}\)/);
		assert.match(transcript, /Tool result \(calculator\): 4/);
	});
});

describe('mapMessages — history omitted on resume', () => {
	it("history: 'omit' drops prior turns — the session already holds them", () => {
		const mapped = mapMessages(
			[new HumanMessage('what is 2+2?'), new AIMessage('4'), new HumanMessage('and doubled?')],
			{ history: 'omit' },
		);
		assert.equal(mapped.prompt, 'and doubled?');
	});

	it("history: 'omit' keeps the system message and the current message's images", () => {
		const png = Buffer.from('x').toString('base64');
		const mapped = mapMessages(
			[
				new SystemMessage('be terse'),
				new HumanMessage('earlier'),
				new AIMessage('noted'),
				new HumanMessage({
					content: [
						{ type: 'text', text: 'and this?' },
						{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
					],
				}),
			],
			{ history: 'omit' },
		);
		assert.equal(mapped.system, 'be terse');
		const blocks = blocksOf(mapped.prompt);
		assert.equal(blocks.length, 2, 'image + question, no transcript block');
		assert.equal(blocks[0].type, 'image');
		assert.equal(blocks[1].text, 'and this?');
	});
});

describe('mapMessages — images', () => {
	it('a data-URI image on the current message becomes a base64 image block before the text', () => {
		const png = Buffer.from('fake').toString('base64');
		const mapped = mapMessages([
			new HumanMessage({
				content: [
					{ type: 'text', text: 'what colour is this?' },
					{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
				],
			}),
		]);
		const blocks = blocksOf(mapped.prompt) as Array<{
			type?: string;
			text?: string;
			source?: { type?: string; data?: string; media_type?: string };
		}>;
		assert.equal(blocks.length, 2);
		assert.equal(blocks[0].type, 'image');
		assert.equal(blocks[0].source?.type, 'base64');
		assert.equal(blocks[0].source?.media_type, 'image/png');
		assert.equal(blocks[0].source?.data, png);
		// The question comes after the content it is about.
		assert.equal(blocks[1].type, 'text');
		assert.equal(blocks[1].text, 'what colour is this?');
	});

	it('an http image url becomes a url-source image block', () => {
		const mapped = mapMessages([
			new HumanMessage({
				content: [
					{ type: 'text', text: 'describe' },
					{ type: 'image_url', image_url: 'https://example.com/cat.png' },
				],
			}),
		]);
		const blocks = blocksOf(mapped.prompt) as Array<{
			type?: string;
			source?: { type?: string; url?: string };
		}>;
		assert.equal(blocks[0].type, 'image');
		assert.deepEqual(blocks[0].source, { type: 'url', url: 'https://example.com/cat.png' });
	});

	it('an image in HISTORY is noted, not resent — only the current turn carries blocks', () => {
		const mapped = mapMessages([
			new HumanMessage({
				content: [
					{ type: 'text', text: 'look' },
					{ type: 'image_url', image_url: 'https://example.com/old.png' },
				],
			}),
			new AIMessage('a cat'),
			new HumanMessage('and now?'),
		]);
		const blocks = blocksOf(mapped.prompt);
		assert.equal(blocks.length, 2, 'no image block for the history image');
		assert.match(blocks[0].text ?? '', /User: \[sent an image\] look/);
	});
});
