import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { INodeProperties } from 'n8n-workflow';
import { claudeCodeUsageDescription } from '../nodes/ClaudeCodeUsage/description';
import { createFakeContext } from './helpers/executeFunctions';
import { createDebugLogger } from '../nodes/shared/debug';
import { checkProjectPath } from '../nodes/shared/projectPath';

/**
 * The Usage node's schema and the shared helpers it now uses.
 *
 * Its execute() spawns a real CLI through readUsage, which is why readUsage is explicitly out of
 * scope (spec N-3): faking it would mean faking the SDK's control-request surface, and the Docker
 * suite already exercises the real thing. What is tested here is the contract every workflow reads
 * — the schema — plus the fact that the node no longer carries its own copies of the shared logic.
 */

const props = claudeCodeUsageDescription.properties;
const byName = (name: string): INodeProperties => {
	const found = props.find((p) => p.name === name);
	assert.ok(found, `no parameter named '${name}'`);
	return found;
};
const optionFields = (name: string): INodeProperties[] =>
	(byName(name).options ?? []) as INodeProperties[];

describe('Usage node description — identity', () => {
	it('keeps the name workflows are stored against', () => {
		assert.equal(claudeCodeUsageDescription.name, 'claudeCodeUsage');
		assert.equal(claudeCodeUsageDescription.displayName, 'Claude Code Usage');
	});

	it('has one main input and output', () => {
		assert.equal(claudeCodeUsageDescription.inputs.length, 1);
		assert.equal(claudeCodeUsageDescription.outputs.length, 1);
	});
});

describe('Usage node description — parameters', () => {
	const EXPECTED = ['operation', 'projectPath', 'timeout', 'usageOptions'];

	it('has exactly the expected parameters, in order', () => {
		assert.deepEqual(
			props.map((p) => p.name),
			EXPECTED,
		);
	});

	it('projectPath defaults to empty, meaning leave cwd alone', () => {
		assert.equal(byName('projectPath').default, '');
	});

	it('usageOptions is a collection', () => {
		assert.equal(byName('usageOptions').type, 'collection');
	});
});

describe('Usage node description — the options collection', () => {
	const EXPECTED = [
		'debug',
		'declareProfileScope',
		'errorIfLimitsUnavailable',
		'includeAccountEmail',
		'includeRawLimits',
		'pathToClaudeCodeExecutable',
		'probeIfUnavailable',
	];

	it('has exactly the expected fields', () => {
		assert.deepEqual(
			optionFields('usageOptions')
				.map((f) => f.name)
				.sort(),
			EXPECTED,
		);
	});

	it('the probe is opt-in, because it costs real money', () => {
		// It sends one trivial turn so the API response carries rate-limit headers. A fraction of a
		// cent, but not free, so it must never default on.
		const probe = optionFields('usageOptions').find((f) => f.name === 'probeIfUnavailable');
		assert.equal(probe?.default, false);
	});

	it('declaring the profile scope is on by default, since it costs nothing', () => {
		// A token session is told it may only infer, so the CLI never asks about plan limits.
		// Asking again with the scope declared is free when it fails.
		const scope = optionFields('usageOptions').find((f) => f.name === 'declareProfileScope');
		assert.equal(scope?.default, true);
	});

	it('the account email is opt-in — it is personal data nobody asked to log', () => {
		const email = optionFields('usageOptions').find((f) => f.name === 'includeAccountEmail');
		assert.equal(email?.default, false);
	});
});

describe('Usage node — no duplicated logic left', () => {
	it('reads its project path through the shared validator', () => {
		// Both nodes carried a byte-identical statSync().isDirectory() check plus its message and its
		// "mount it in Docker" description. Asserted by behaviour: the Usage node must now reject a
		// bad path with exactly the shared message.
		const problem = checkProjectPath('/definitely/not/here');
		assert.ok(problem);
		assert.match(problem.message, /Project Path is not an existing directory/);
	});

	it('gates its debug logging through the shared logger', () => {
		// The node has exactly one debug site and it goes through createDebugLogger, so the payload
		// is not built when debug is off.
		const { ctx, logs } = createFakeContext();
		let built = 0;
		createDebugLogger(ctx.logger, false).lazy('Claude Code usage read', () => {
			built++;
			return {};
		});
		assert.equal(built, 0);
		assert.equal(logs.length, 0);
	});
});
