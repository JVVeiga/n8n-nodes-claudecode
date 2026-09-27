import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	orchestrationInstruction,
	unattendedInstruction,
} from '../nodes/ClaudeCodeAgent/orchestration';

describe('orchestrationInstruction', () => {
	it('is null when no subagent is connected', () => {
		assert.equal(orchestrationInstruction([]), null);
	});

	it('names every subagent', () => {
		const text = orchestrationInstruction(['alpha', 'beta', 'security-reviewer']);
		assert.ok(text);
		for (const name of ['alpha', 'beta', 'security-reviewer']) {
			assert.match(text, new RegExp(`^- ${name}$`, 'm'));
		}
	});

	it('asks for every one of them before the final answer, and to use their results', () => {
		const text = orchestrationInstruction(['alpha']) ?? '';
		assert.match(text, /EVERY one/);
		assert.match(text, /before writing your final answer/i);
		assert.match(text, /Base your final answer on their results/);
	});
});

describe('unattendedInstruction', () => {
	it('says nobody is there, and to decide and deliver instead of asking', () => {
		const text = unattendedInstruction({ structured: false, subagents: false });
		assert.match(text, /unattended/);
		assert.match(text, /nobody/i);
		assert.match(text, /never end with a question/i);
		assert.doesNotMatch(text, /structured output|subagent/);
	});

	it('a schema alone, or subagents alone, add nothing', () => {
		const plain = unattendedInstruction({ structured: false, subagents: false });
		assert.equal(unattendedInstruction({ structured: true, subagents: false }), plain);
		assert.equal(unattendedInstruction({ structured: false, subagents: true }), plain);
	});

	it('a schema with subagents asks for one delivery after all of them, and a fix on rejection', () => {
		const plain = unattendedInstruction({ structured: false, subagents: false });
		const text = unattendedInstruction({ structured: true, subagents: true });
		assert.ok(text.startsWith(plain));
		assert.match(text, /structured output once/);
		assert.match(text, /after every subagent/);
		assert.match(text, /validator/);
		assert.match(text, /send it again/);
	});

	it('stays short', () => {
		assert.ok(unattendedInstruction({ structured: true, subagents: true }).length < 500);
	});
});
