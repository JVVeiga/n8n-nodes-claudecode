import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readChatModelSettings, resolveMemoryMode } from '../nodes/ClaudeCodeChatModel/params';
import { createFakeContext } from './helpers/executeFunctions';

const settings = (params: Record<string, unknown>) =>
	readChatModelSettings(createFakeContext({ params }).ctx, 0);

describe('readChatModelSettings — session continuity', () => {
	it('an empty Session ID starts fresh: operation query', () => {
		const s = settings({ model: 'sonnet', projectPath: '', sessionId: '', options: {} });
		assert.equal(s.params.operation, 'query');
		assert.equal(s.params.sessionId, '');
	});

	it('a Session ID rides the continue path — the existing resumeOrContinue applier', () => {
		const s = settings({
			model: 'sonnet',
			projectPath: '',
			sessionId: '  0b7f2c1e-3d4a-4b5c-8d9e-1f2a3b4c5d6e  ',
			options: {},
		});
		assert.equal(s.params.operation, 'continue');
		// Trimmed: an expression that resolves with whitespace must not break the resume.
		assert.equal(s.params.sessionId, '0b7f2c1e-3d4a-4b5c-8d9e-1f2a3b4c5d6e');
	});

	it('auto keeps the pre-selector behaviour exactly: a Session ID decides', () => {
		assert.equal(resolveMemoryMode('auto', 'discord:1'), 'session');
		assert.equal(resolveMemoryMode('auto', ''), 'memory');
	});

	it('an explicit choice wins over what the field happens to hold', () => {
		// Memory mode with a leftover Session ID must not resume: the author said Memory.
		assert.equal(resolveMemoryMode('memory', 'discord:1'), 'memory');
		assert.equal(resolveMemoryMode('session', 'discord:1'), 'session');
	});

	it('Memory mode ignores a Session ID that is still stored on the node', () => {
		const s = settings({
			model: 'sonnet',
			projectPath: '',
			memorySource: 'memory',
			sessionId: 'discord:leftover',
			options: {},
		});
		assert.equal(s.memoryMode, 'memory');
		assert.equal(s.params.operation, 'query', 'never resumes in Memory mode');
	});

	it('Session mode routes through the continue path', () => {
		const s = settings({
			model: 'sonnet',
			projectPath: '',
			memorySource: 'session',
			sessionId: 'discord:1',
			options: {},
		});
		assert.equal(s.memoryMode, 'session');
		assert.equal(s.params.operation, 'continue');
	});

	it('fields this node does not expose stay pinned to their neutral values', () => {
		const s = settings({ model: 'sonnet', projectPath: '', options: {} });
		assert.equal(s.params.prompt, '');
		assert.equal(s.params.outputFormat, 'text');
		assert.equal(s.params.attachments.all, false);
		assert.equal(s.params.additional.permissionMode, 'bypassPermissions');
	});
});
