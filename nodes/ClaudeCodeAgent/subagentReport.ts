import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
	countContent,
	isTaskNotification,
	isTaskStarted,
	type TaskNotificationMessage,
} from '../shared/sdkMessage';
import type { SubagentInvocation } from '../shared/subagent';
import { num, sum } from './values';

// The CLI changes these fields between versions, so every read tolerates absence.
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * One entry per subagent delegation, in the order they started. Subagents' own messages are not
 * streamed, so the started/notification pair is the only record of what each one did. Tasks with
 * no `subagent_type` (background shells, workflows) are not subagents and are left out.
 */
export function subagentInvocations(messages: SDKMessage[]): SubagentInvocation[] {
	const notifications = new Map<string, TaskNotificationMessage>();
	for (const m of messages) {
		if (isTaskNotification(m) && typeof m.task_id === 'string') notifications.set(m.task_id, m);
	}

	const invocations: SubagentInvocation[] = [];
	for (const m of messages) {
		if (!isTaskStarted(m)) continue;
		const name = str(m.subagent_type);
		if (name === null) continue;
		const done = notifications.get(m.task_id);
		const usage: Record<string, unknown> =
			typeof done?.usage === 'object' && done.usage !== null ? done.usage : {};
		invocations.push({
			name,
			description: str(m.description),
			prompt: str(m.prompt),
			status: str(done?.status),
			summary: str(done?.summary),
			totalTokens: num(usage.total_tokens),
			toolUses: num(usage.tool_uses),
			durationMs: num(usage.duration_ms),
		});
	}
	return invocations;
}

export type SubagentDiagnostics = {
	name: string;
	invocations: number;
	completed: number;
	/** Sums over the subagent's invocations; null when no invocation reported the figure. */
	totalTokens: number | null;
	toolUses: number | null;
	durationMs: number | null;
};

/** One entry per connected subagent, in the order given, so one that never ran is visible. */
export function buildSubagentReport(
	messages: SDKMessage[],
	connectedNames: string[],
): SubagentDiagnostics[] {
	const invocations = subagentInvocations(messages);
	return connectedNames.map((name) => {
		const own = invocations.filter((i) => i.name === name);
		return {
			name,
			invocations: own.length,
			completed: own.filter((i) => i.status === 'completed').length,
			totalTokens: sum(own.map((i) => i.totalTokens)),
			toolUses: sum(own.map((i) => i.toolUses)),
			durationMs: sum(own.map((i) => i.durationMs)),
		};
	});
}

/** The CLI invokes subagents through a tool named `Agent` while listing it as `Task` in init. */
export const countSubagentToolUses = (messages: SDKMessage[]): number =>
	countContent(messages, (c) => c.type === 'tool_use' && (c.name === 'Agent' || c.name === 'Task'));
