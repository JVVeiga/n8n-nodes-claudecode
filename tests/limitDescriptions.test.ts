import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { INodeProperties, INodeTypeDescription } from 'n8n-workflow';
import { claudeCodeDescription } from '../nodes/ClaudeCode/description/properties';
import { claudeCodeAgentDescription } from '../nodes/ClaudeCodeAgent/description';
import { claudeCodeChatModelDescription } from '../nodes/ClaudeCodeChatModel/description';
import { claudeCodeToolDescription } from '../nodes/ClaudeCodeTool/description';

const NODES: Array<[string, INodeTypeDescription]> = [
	['Claude Code', claudeCodeDescription],
	['Claude Code Agent', claudeCodeAgentDescription],
	['Claude Code Chat Model', claudeCodeChatModelDescription],
	['Claude Code Task Tool', claudeCodeToolDescription],
];

/** Every property with this name, at any depth of collections. */
function findAll(properties: INodeProperties[], name: string): INodeProperties[] {
	const found: INodeProperties[] = [];
	for (const p of properties) {
		if (p.name === name) found.push(p);
		const nested = (p.options ?? []).filter(
			(o): o is INodeProperties => typeof o === 'object' && o !== null && 'type' in o,
		);
		found.push(...findAll(nested, name));
	}
	return found;
}

describe('the run limits say what they enforce', () => {
	for (const [label, description] of NODES) {
		it(`${label}: Max Budget is checked between turns, not a hard cap`, () => {
			const [budget] = findAll(description.properties, 'maxBudgetUsd');
			assert.ok(budget, 'Max Budget is offered');
			const text = budget.description ?? '';
			assert.doesNotMatch(text, /hard (spend )?cap/i);
			assert.match(text, /between turns/);
			assert.match(text, /Timeout/);
			assert.match(text, /Max Turns/);
		});

		it(`${label}: Max Turns says 0 means no limit`, () => {
			const [turns] = findAll(description.properties, 'maxTurns');
			assert.ok(turns, 'Max Turns is offered');
			assert.match(turns.description ?? '', /0 (means|for) no limit/);
		});
	}
});
