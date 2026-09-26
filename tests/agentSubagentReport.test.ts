import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSubagentReport, subagentInvocations } from '../nodes/ClaudeCodeAgent/subagentReport';
import { countSubagentToolUses } from '../nodes/shared/sdkMessage';
import { assistantTool, init, msg, SESSION } from './helpers/sdkMessages';

// Shaped after a recorded host run with two subagents, alpha and beta.

const started = (taskId: string, subagentType: string | undefined, description: string) =>
	msg({
		type: 'system',
		subtype: 'task_started',
		task_id: taskId,
		tool_use_id: `toolu_${taskId}`,
		description,
		...(subagentType === undefined ? {} : { subagent_type: subagentType }),
		is_backgrounded: false,
		spawn_depth: 1,
		task_type: subagentType === undefined ? 'local_bash' : 'local_agent',
		prompt: 'What is your codeword?',
		uuid: `u-${taskId}`,
		session_id: SESSION,
	});

const updated = (taskId: string) =>
	msg({
		type: 'system',
		subtype: 'task_updated',
		task_id: taskId,
		patch: { status: 'completed', end_time: 1790367193012 },
		session_id: SESSION,
	});

const notified = (
	taskId: string,
	status: string,
	summary: string,
	usage: object | null = { total_tokens: 20720, tool_uses: 0, duration_ms: 2031 },
) =>
	msg({
		type: 'system',
		subtype: 'task_notification',
		task_id: taskId,
		tool_use_id: `toolu_${taskId}`,
		status,
		output_file: `/tmp/tasks/${taskId}.output`,
		summary,
		...(usage === null ? {} : { usage }),
		session_id: SESSION,
	});

const recordedRun = () => [
	init({ tools: ['Task', 'Read', 'SendMessage', 'ListAgents'] }),
	assistantTool('SendMessage'),
	assistantTool('ListAgents'),
	assistantTool('Agent'),
	started('a162', 'alpha', "Get alpha's codeword"),
	updated('a162'),
	notified('a162', 'completed', 'ALPHA-313', {
		total_tokens: 20720,
		tool_uses: 0,
		duration_ms: 2031,
	}),
	assistantTool('Agent'),
	started('a310', 'beta', "Get beta's codeword"),
	updated('a310'),
	notified('a310', 'completed', 'BETA-727', {
		total_tokens: 20712,
		tool_uses: 0,
		duration_ms: 1554,
	}),
];

describe('subagentInvocations', () => {
	it('pairs each started task with its notification', () => {
		assert.deepEqual(subagentInvocations(recordedRun()), [
			{
				name: 'alpha',
				description: "Get alpha's codeword",
				prompt: 'What is your codeword?',
				status: 'completed',
				summary: 'ALPHA-313',
				totalTokens: 20720,
				toolUses: 0,
				durationMs: 2031,
			},
			{
				name: 'beta',
				description: "Get beta's codeword",
				prompt: 'What is your codeword?',
				status: 'completed',
				summary: 'BETA-727',
				totalTokens: 20712,
				toolUses: 0,
				durationMs: 1554,
			},
		]);
	});

	it('keeps a started task with no notification, with nulls', () => {
		const [only] = subagentInvocations([started('t1', 'alpha', 'still running')]);
		assert.deepEqual(only, {
			name: 'alpha',
			description: 'still running',
			prompt: 'What is your codeword?',
			status: null,
			summary: null,
			totalTokens: null,
			toolUses: null,
			durationMs: null,
		});
	});

	it('reads a notification without usage as nulls, not zeroes', () => {
		const [only] = subagentInvocations([
			started('t1', 'alpha', 'd'),
			notified('t1', 'failed', 'boom', null),
		]);
		assert.equal(only.status, 'failed');
		assert.equal(only.summary, 'boom');
		assert.equal(only.totalTokens, null);
		assert.equal(only.durationMs, null);
	});

	it('pairs by task id even when notifications arrive out of order', () => {
		const invocations = subagentInvocations([
			started('t1', 'alpha', 'first'),
			started('t2', 'beta', 'second'),
			notified('t2', 'completed', 'B'),
			notified('t1', 'stopped', 'A'),
		]);
		assert.deepEqual(
			invocations.map((i) => [i.name, i.status, i.summary]),
			[
				['alpha', 'stopped', 'A'],
				['beta', 'completed', 'B'],
			],
		);
	});

	it('leaves out tasks that are not subagents', () => {
		assert.deepEqual(
			subagentInvocations([
				started('sh', undefined, 'npm test'),
				notified('sh', 'completed', 'ok'),
			]),
			[],
		);
	});

	it('ignores a notification with no started task', () => {
		assert.deepEqual(subagentInvocations([notified('ghost', 'completed', 'x')]), []);
	});
});

describe('buildSubagentReport', () => {
	it('reports one entry per connected subagent, in the order given', () => {
		assert.deepEqual(buildSubagentReport(recordedRun(), ['alpha', 'beta']), [
			{
				name: 'alpha',
				invocations: 1,
				completed: 1,
				totalTokens: 20720,
				toolUses: 0,
				durationMs: 2031,
			},
			{
				name: 'beta',
				invocations: 1,
				completed: 1,
				totalTokens: 20712,
				toolUses: 0,
				durationMs: 1554,
			},
		]);
	});

	it('reports a connected subagent that never ran as zero invocations and null figures', () => {
		const [, gamma] = buildSubagentReport(recordedRun(), ['alpha', 'gamma']);
		assert.deepEqual(gamma, {
			name: 'gamma',
			invocations: 0,
			completed: 0,
			totalTokens: null,
			toolUses: null,
			durationMs: null,
		});
	});

	it('sums repeated invocations and counts only completed ones as completed', () => {
		const [alpha] = buildSubagentReport(
			[
				started('t1', 'alpha', 'one'),
				notified('t1', 'completed', 'A', { total_tokens: 100, tool_uses: 2, duration_ms: 10 }),
				started('t2', 'alpha', 'two'),
				notified('t2', 'failed', 'B', { total_tokens: 50, tool_uses: 1, duration_ms: 5 }),
				started('t3', 'alpha', 'three'),
			],
			['alpha'],
		);
		assert.deepEqual(alpha, {
			name: 'alpha',
			invocations: 3,
			completed: 1,
			totalTokens: 150,
			toolUses: 3,
			durationMs: 15,
		});
	});

	it('is empty when nothing is connected', () => {
		assert.deepEqual(buildSubagentReport(recordedRun(), []), []);
	});
});

describe('countSubagentToolUses', () => {
	it('counts the Agent tool the CLI actually calls', () => {
		assert.equal(countSubagentToolUses(recordedRun()), 2);
	});

	it('counts Task as well, and nothing else', () => {
		assert.equal(
			countSubagentToolUses([
				assistantTool('Task'),
				assistantTool('Agent'),
				assistantTool('Read'),
				assistantTool('SendMessage'),
			]),
			2,
		);
	});

	it('is zero for a run without subagents', () => {
		assert.equal(countSubagentToolUses([init(), assistantTool('Read')]), 0);
	});
});
