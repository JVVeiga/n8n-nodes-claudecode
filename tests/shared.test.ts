import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from 'n8n-workflow';
import { checkProjectPath, PROJECT_PATH_DESCRIPTION } from '../nodes/shared/projectPath';
import { createDebugLogger } from '../nodes/shared/debug';
import {
	assistantMessages,
	countContent,
	countToolUses,
	findInit,
	findResult,
	lastAssistantText,
	lastResult,
} from '../nodes/shared/sdkMessage';
import { assistantText, init, streams, WRAP_UP_TEXT } from './helpers/sdkMessages';

describe('checkProjectPath', () => {
	it('accepts an empty path, which means leave cwd alone', () => {
		assert.equal(
			checkProjectPath('', () => false),
			null,
		);
		assert.equal(
			checkProjectPath('   ', () => false),
			null,
		);
	});

	it('accepts an existing directory', () => {
		assert.equal(
			checkProjectPath('/workspace', (p) => p === '/workspace'),
			null,
		);
	});

	it('trims before checking, so a pasted path with whitespace still resolves', () => {
		const seen: string[] = [];
		checkProjectPath('  /workspace  ', (p) => {
			seen.push(p);
			return true;
		});
		assert.deepEqual(seen, ['/workspace']);
	});

	it('reports the offending path and how to fix it', () => {
		const problem = checkProjectPath('/nope', () => false);
		assert.ok(problem);
		assert.equal(problem.message, 'Project Path is not an existing directory: /nope');
		assert.equal(problem.description, PROJECT_PATH_DESCRIPTION);
	});

	it('mentions Docker mounting, which is the actual cause most of the time', () => {
		assert.match(PROJECT_PATH_DESCRIPTION, /Docker/);
		assert.match(PROJECT_PATH_DESCRIPTION, /mounted/);
	});

	it('treats a file as not a directory', () => {
		// The real isDirectory() distinguishes these; the injected one here stands in for a stat
		// that succeeded on a regular file.
		const problem = checkProjectPath('/etc/hosts', () => false);
		assert.ok(problem);
	});

	it('uses the real filesystem when no checker is injected', () => {
		assert.equal(checkProjectPath(process.cwd()), null);
		assert.ok(checkProjectPath('/definitely/not/here/at/all'));
	});
});

const spyLogger = () => {
	const calls: Array<{ level: string; message: string; meta?: unknown }> = [];
	const logger = {
		debug: (message: string, meta?: unknown) => calls.push({ level: 'debug', message, meta }),
		info: (message: string, meta?: unknown) => calls.push({ level: 'info', message, meta }),
		warn: (message: string, meta?: unknown) => calls.push({ level: 'warn', message, meta }),
		error: (message: string, meta?: unknown) => calls.push({ level: 'error', message, meta }),
	} as unknown as Logger;
	return { logger, calls };
};

describe('createDebugLogger', () => {
	it('forwards when enabled', () => {
		const { logger, calls } = spyLogger();
		createDebugLogger(logger, true).log('hello', { a: 1 });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].level, 'debug');
		assert.equal(calls[0].message, 'hello');
	});

	it('is a no-op when disabled', () => {
		const { logger, calls } = spyLogger();
		createDebugLogger(logger, false).log('hello', { a: 1 });
		assert.equal(calls.length, 0);
	});

	it('reports its own state, so callers can skip expensive work entirely', () => {
		const { logger } = spyLogger();
		assert.equal(createDebugLogger(logger, true).enabled, true);
		assert.equal(createDebugLogger(logger, false).enabled, false);
	});

	it('does not build a lazy payload when disabled — the whole point of the thunk', () => {
		const { logger } = spyLogger();
		let built = 0;
		createDebugLogger(logger, false).lazy('summary', () => {
			built++;
			return {};
		});
		assert.equal(built, 0);
	});

	it('does build a lazy payload when enabled', () => {
		const { logger, calls } = spyLogger();
		let built = 0;
		createDebugLogger(logger, true).lazy('summary', () => {
			built++;
			return { n: 1 };
		});
		assert.equal(built, 1);
		assert.deepEqual(calls[0].meta, { n: 1 });
	});

	it('reports errors even when debug is off — an error is not a diagnostic', () => {
		const { logger, calls } = spyLogger();
		createDebugLogger(logger, false).error('it broke', { why: 'reasons' });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].level, 'error');
	});
});

describe('sdkMessage narrowing helpers', () => {
	it('findInit returns the FIRST init — a graceful timeout re-inits the session', () => {
		const messages = streams.gracefulTimeout();
		const initCount = messages.filter(
			(m) => m.type === 'system' && (m as { subtype?: string }).subtype === 'init',
		).length;
		assert.equal(initCount, 2, 'fixture must have two inits for this test to mean anything');
		assert.equal(findInit(messages), messages[0]);
	});

	it('findResult returns the first result, lastResult the last — they differ on a timeout', () => {
		const messages = streams.gracefulTimeout();
		const first = findResult(messages) as { subtype?: string };
		const last = lastResult(messages) as { subtype?: string };
		assert.equal(first.subtype, 'error_during_execution', 'the interrupt result');
		assert.equal(last.subtype, 'success', 'the wrap-up result');
	});

	it('both return undefined when no result ever arrived', () => {
		assert.equal(findResult(streams.hardAbortNoResult()), undefined);
		assert.equal(lastResult(streams.hardAbortNoResult()), undefined);
	});

	it('assistantMessages picks only assistant turns', () => {
		assert.equal(assistantMessages(streams.success()).length, 2);
		assert.equal(assistantMessages([init()]).length, 0);
	});

	it('lastAssistantText takes the last non-empty text, not the first', () => {
		const messages = [init(), assistantText('first'), assistantText('second')];
		assert.equal(lastAssistantText(messages), 'second');
	});

	it('lastAssistantText skips empty text rather than returning an empty string', () => {
		const messages = [init(), assistantText('real'), assistantText('')];
		assert.equal(lastAssistantText(messages), 'real');
	});

	it('lastAssistantText is null when there is no text at all', () => {
		assert.equal(lastAssistantText([init()]), null);
		// A tool-use-only stream has assistant messages but no text blocks.
		assert.equal(lastAssistantText(streams.hardAbortNoResult()), null);
	});

	it('lastAssistantText finds the wrap-up summary on a graceful timeout', () => {
		assert.equal(lastAssistantText(streams.gracefulTimeout()), WRAP_UP_TEXT);
	});

	it('countContent counts blocks across every assistant message', () => {
		assert.equal(
			countContent(streams.ultracode(), (c) => c.type === 'tool_use'),
			2,
		);
		assert.equal(
			countContent(streams.ultracode(), (c) => c.type === 'thinking'),
			1,
		);
		assert.equal(
			countContent(streams.ultracode(), (c) => c.type === 'text'),
			1,
		);
	});

	it('countToolUses matches by name', () => {
		assert.equal(countToolUses(streams.ultracode(), 'Workflow'), 1);
		assert.equal(countToolUses(streams.ultracode(), 'Task'), 1);
		assert.equal(countToolUses(streams.ultracode(), 'Bash'), 0);
	});

	it('every helper survives a stream with nothing but an init message', () => {
		const messages = streams.empty();
		assert.ok(findInit(messages));
		assert.equal(findResult(messages), undefined);
		assert.equal(lastResult(messages), undefined);
		assert.deepEqual(assistantMessages(messages), []);
		assert.equal(lastAssistantText(messages), null);
		assert.equal(
			countContent(messages, () => true),
			0,
		);
	});
});
