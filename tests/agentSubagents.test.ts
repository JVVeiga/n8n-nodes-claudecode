import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSubagents } from '../nodes/ClaudeCodeAgent/subagents';
import { SUBAGENT_TAG, type SuppliedSubagent } from '../nodes/shared/subagent';

const subagent = (name: string, prompt = `You are ${name}.`): SuppliedSubagent => ({
	[SUBAGENT_TAG]: 1,
	name,
	definition: { description: `Use ${name}.`, prompt },
});

describe('buildSubagents', () => {
	it('returns an empty record for nothing connected', () => {
		assert.deepEqual(buildSubagents(undefined), { agents: {}, supplied: [] });
		assert.deepEqual(buildSubagents(null), { agents: {}, supplied: [] });
		assert.deepEqual(buildSubagents([]), { agents: {}, supplied: [] });
	});

	it('accepts a single delivered subagent, not only an array', () => {
		const alpha = subagent('alpha');
		const result = buildSubagents(alpha);
		assert.ok(!('problem' in result));
		assert.deepEqual(result.agents, { alpha: alpha.definition });
		assert.deepEqual(result.supplied, [alpha]);
	});

	it('sorts by name, whatever order n8n delivered them in', () => {
		const result = buildSubagents([subagent('gamma'), subagent('alpha'), subagent('beta')]);
		assert.ok(!('problem' in result));
		assert.deepEqual(Object.keys(result.agents), ['alpha', 'beta', 'gamma']);
		assert.deepEqual(
			result.supplied.map((s) => s.name),
			['alpha', 'beta', 'gamma'],
		);
	});

	it('keeps each definition under its own name', () => {
		const result = buildSubagents([subagent('beta', 'B'), subagent('alpha', 'A')]);
		assert.ok(!('problem' in result));
		assert.equal(result.agents.alpha.prompt, 'A');
		assert.equal(result.agents.beta.prompt, 'B');
	});

	it('keeps the log closure on the supplied entry', () => {
		const log = () => undefined;
		const result = buildSubagents([{ ...subagent('alpha'), log }]);
		assert.ok(!('problem' in result));
		assert.equal(result.supplied[0].log, log);
	});

	it('names every duplicated name', () => {
		const result = buildSubagents([
			subagent('beta'),
			subagent('alpha'),
			subagent('beta'),
			subagent('alpha'),
			subagent('gamma'),
		]);
		assert.ok('problem' in result);
		assert.match(result.problem.message, /'alpha'/);
		assert.match(result.problem.message, /'beta'/);
		assert.doesNotMatch(result.problem.message, /gamma/);
		assert.match(result.problem.description ?? '', /unique Name/);
	});

	it('rejects an untagged object and says what it got', () => {
		const result = buildSubagents([subagent('alpha'), { name: 'search', invoke: () => '' }]);
		assert.ok('problem' in result);
		assert.match(result.problem.message, /keys name, invoke/);
		assert.match(result.problem.description ?? '', /Only Claude Code Subagent nodes/);
	});

	it('rejects a value that is not an object', () => {
		const result = buildSubagents('alpha');
		assert.ok('problem' in result);
		assert.match(result.problem.message, /a string/);
	});

	it('rejects a tagged object missing its name or definition', () => {
		for (const bad of [
			{ [SUBAGENT_TAG]: 1, definition: { description: 'd', prompt: 'p' } },
			{ [SUBAGENT_TAG]: 1, name: 'alpha' },
			{ [SUBAGENT_TAG]: 2, name: 'alpha', definition: { description: 'd', prompt: 'p' } },
		]) {
			assert.ok('problem' in buildSubagents([bad]), JSON.stringify(bad));
		}
	});
});
