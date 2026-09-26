import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import type { AuthMode } from '../shared/auth';
import type { DebugLogger } from '../shared/debug';
import { readRunIndex, usageReporting } from '../shared/reportUsage';
import type { SuppliedSubagent } from '../shared/subagent';
import { createSequence, reportRun, type UsageReporting } from '../shared/usageReport';
import type { AgentExtras } from './params';
import { subagentInvocations } from './subagentReport';
import type { Attempt } from './turn';

export type AgentReporting = { usage: UsageReporting; authMode: AuthMode; debug: DebugLogger };

/** Null when no collector was chosen. */
export function agentReporting(
	ctx: IExecuteFunctions,
	agent: AgentExtras,
	debug: DebugLogger,
	itemIndex: number,
	authMode: AuthMode,
): AgentReporting | null {
	const usage = usageReporting(ctx, agent, debug, createSequence(), itemIndex);
	if (!usage) return null;
	return {
		usage: { ...usage, context: { ...usage.context, runIndex: readRunIndex(ctx, itemIndex) } },
		authMode,
		debug,
	};
}

/**
 * One report per CLI run: a resume that found nothing was still a run, and may have cost. A
 * verification run is not reported on its own: its cost already includes the run it resumed, so
 * the final report carries the combined metrics instead.
 */
export async function reportAttempts(
	reporting: AgentReporting,
	attempts: Attempt[],
	finalDiagnostics: Record<string, unknown> | null,
	finalMetrics: IDataObject | null,
): Promise<void> {
	for (const [index, attempt] of attempts.entries()) {
		const isFinal = index === attempts.length - 1;
		await reportRun({
			usage: reporting.usage,
			messages: attempt.sdkMessages,
			durationMs: attempt.run.durationMs,
			params: attempt.params,
			appliedEffort: attempt.run.appliedEffort,
			authMode: reporting.authMode,
			debug: reporting.debug,
			diagnostics: isFinal && finalDiagnostics ? (finalDiagnostics as IDataObject) : undefined,
			metrics: isFinal && finalMetrics ? finalMetrics : undefined,
		});
	}
}

export function logSubagentInvocations(
	supplied: SuppliedSubagent[],
	attempts: Attempt[],
	debug: DebugLogger,
): void {
	const byName = new Map(supplied.map((s) => [s.name, s]));
	for (const attempt of attempts) {
		for (const invocation of subagentInvocations(attempt.sdkMessages)) {
			const log = byName.get(invocation.name)?.log;
			if (!log) continue;
			try {
				log(invocation);
			} catch (error) {
				debug.error('Subagent log failed (the run itself is unaffected)', {
					subagent: invocation.name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
}
