import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { orchestrationInstruction } from '../nodes/ClaudeCodeAgent/orchestration';

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
