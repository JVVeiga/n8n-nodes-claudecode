import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { IDataObject } from 'n8n-workflow';
import type { DebugLogger } from './debug';
import { buildRunMetrics } from '../ClaudeCode/output/metrics';
import type { AuthMode } from './auth';
import type { ClaudeCodeParams } from '../ClaudeCode/types';
import { buildDiagnostics } from '../ClaudeCode/diagnostics';

/**
 * What a sub-node reports about a run, and how it gets out.
 *
 * A sub-node's output is not on the `main` chain, so no expression can read it — measured, and
 * it is why `$('Claude Code').item.json.metrics` works for the main node and cannot work here.
 * What a sub-node CAN do is call a workflow (`executeWorkflow` is inherited by the supply
 * context), so reporting is a call rather than a value someone downstream picks up.
 *
 * The payload is deliberately the shape the main node already emits — `{ metrics, diagnostics }`
 * — so an existing collector workflow consumes a sub-node's run without knowing it came from
 * one. `buildRunMetrics` is the same function `output/v12.ts` uses, not a restatement of it:
 * the parity has to be structural, or the two drift and a dashboard silently mixes shapes.
 */

export type UsageReportInput = {
	processName: string;
	/** Unique per call. See `buildRunKey` for why it is not the session id. */
	runKey: string;
	callerWorkflowId: string;
	callerExecutionId: string;
	nodeName: string;
	messages: SDKMessage[];
	durationMs: number;
	diagnostics: IDataObject | null;
};

export function buildUsageReport(input: UsageReportInput): IDataObject {
	return {
		process_name: input.processName,
		run_key: input.runKey,
		caller_workflow_id: input.callerWorkflowId,
		caller_execution_id: input.callerExecutionId,
		node_name: input.nodeName,
		metrics: buildRunMetrics(input.messages, input.durationMs),
		diagnostics: input.diagnostics,
	};
}

/**
 * The identity of one reported call: `<executionId>:<node name>:<seq>`.
 *
 * NOT the session id, which is the obvious choice and the wrong one. A conversation that resumes
 * a Claude Code session carries the SAME session id across executions, so keying on it makes
 * every message overwrite the last — and `total_cost_usd` is per run, not cumulative, so the row
 * would end up showing the most recent call rather than the conversation. The session id travels
 * as an ordinary field instead, which is what makes "cost of this conversation" a GROUP BY
 * rather than a number nobody kept.
 *
 * `seq` separates repeated calls of the same node inside one execution — an Agent can invoke a
 * tool several times per turn.
 *
 * `itemIndex` is in the key as defence, not because it does the work today. MEASURED (e2e
 * case72, an Agent fed two items): n8n called `supplyData` ONCE, with itemIndex 0, and the same
 * instance served both items — so the two runs came out as `…:0:1` and `…:0:2` and it was the
 * sequence that separated them. But `supplyData(this, itemIndex)` takes an index precisely
 * because n8n MAY supply per item, and then every instance would start its counter at 1 again;
 * a collector upserting on the key would drop one item's cost. The field costs nothing and
 * closes that door.
 */
export const buildRunKey = (
	executionId: string,
	nodeName: string,
	itemIndex: number,
	seq: number,
): string => `${executionId || 'no-execution'}:${nodeName}:${itemIndex}:${seq}`;

/** A counter per supplied instance: supplyData runs once per execution, so this numbers the
 * calls that instance served. */
export const createSequence = (): (() => number) => {
	let n = 0;
	return () => ++n;
};

export type UsageReporter = (report: IDataObject) => Promise<void>;

/** Who is reporting, for the row's identity. */
export type RunContext = {
	processName: string;
	executionId: string;
	workflowId: string;
	nodeName: string;
	/** The input item this instance was supplied for. Part of the key — see buildRunKey. */
	itemIndex: number;
};

/**
 * Everything reporting needs, as ONE optional dependency.
 *
 * It was three — a reporter, a context and a counter — which let a caller supply two of them and
 * get silence: reporting that looks configured and does nothing is the failure this codebase
 * keeps refusing elsewhere. Absent means the node was not asked to report; present means it can.
 */
export type UsageReporting = {
	report: UsageReporter;
	context: RunContext;
	nextSeq: () => number;
};

/**
 * One reported run, from the pieces every sub-node has at the end of a call.
 *
 * Both sub-nodes built this inline and the two blocks were identical bar the effort value — the
 * same duplication `shared/subNodeParams.ts` and `shared/runOptions.ts` exist to prevent, and it
 * would have drifted the moment one of them learned a new field.
 */
export async function reportRun(input: {
	usage: UsageReporting | undefined;
	messages: SDKMessage[];
	durationMs: number;
	params: ClaudeCodeParams;
	/** The effort Claude Code reported applying. Null when no hook fired — the Task Tool does not
	 * register one. */
	appliedEffort: string | null;
	authMode: AuthMode;
	/** Where a build failure is recorded. Optional so a caller without one still cannot throw. */
	debug?: DebugLogger;
}): Promise<void> {
	const { usage } = input;
	if (!usage) return;

	// The WHOLE body is guarded, not just the call: buildDiagnostics and buildUsageReport run
	// here too, and a throw from either would turn a good answer into a failed Agent run — the
	// one outcome this module refuses. "Guarded twice over" was only true of executeWorkflow.
	try {
		await usage.report(
			buildUsageReport({
				processName: usage.context.processName,
				runKey: buildRunKey(
					usage.context.executionId,
					usage.context.nodeName,
					usage.context.itemIndex,
					usage.nextSeq(),
				),
				callerWorkflowId: usage.context.workflowId,
				callerExecutionId: usage.context.executionId,
				nodeName: usage.context.nodeName,
				messages: input.messages,
				durationMs: input.durationMs,
				// The main node's builder, called here rather than injected: `shared/` already depends
				// on `ClaudeCode/` for types, and an injected function would only hide which one runs.
				diagnostics: buildDiagnostics({
					messages: input.messages,
					params: input.params,
					// Always set by shared/subNodeParams.ts; read straight rather than defaulted twice.
					permissionMode: input.params.additional.permissionMode as string,
					appliedEffort: input.appliedEffort,
					authMode: input.authMode,
				}) as unknown as IDataObject,
			}),
		);
	} catch (error) {
		input.debug?.error('Usage report could not be built (the run itself is unaffected)', {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
