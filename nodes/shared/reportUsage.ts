import type { IDataObject, ISupplyDataFunctions } from 'n8n-workflow';
import type { DebugLogger } from './debug';
import type { UsageReporter, UsageReporting } from './usageReport';

/**
 * The impure half of usage reporting: the only part that touches n8n.
 *
 * Split from `usageReport.ts` for the reason `readAuth.ts` is split from `auth.ts` — the policy
 * (what a report contains, how a run is identified) is pure and testable against plain data,
 * while getting it out of the process needs a context. Keeping them in one file made the whole
 * module untestable without a fake n8n.
 */

/**
 * The whole reporting dependency, or undefined when no collector was chosen. One factory so both
 * node shells build it identically — the node names, the execution id and the counter all come
 * from the same place, and "configured" is a single question with a single answer.
 */
export function usageReporting(
	ctx: ISupplyDataFunctions,
	settings: { usageWorkflowId: string; processName: string },
	debug: DebugLogger,
	nextSeq: () => number,
	itemIndex: number,
): UsageReporting | undefined {
	const report = createUsageReporter(ctx, settings.usageWorkflowId, debug);
	if (!report) return undefined;

	return {
		report,
		context: {
			// An empty Process Name would file a row nobody can attribute. The node's own name is
			// the honest fallback: it is what the canvas calls this run.
			processName: settings.processName || ctx.getNode().name,
			executionId: ctx.getExecutionId(),
			workflowId: ctx.getWorkflow().id ?? '',
			nodeName: ctx.getNode().name,
			itemIndex,
		},
		nextSeq,
	};
}

/**
 * Hands a report to a workflow.
 *
 * `doNotWaitToFinish` means n8n does not wait for the collector to FINISH — it still loads the
 * workflow and creates the execution before this resolves, so the cost is a workflow start per
 * call, not a full collector run. And because the sub-execution is detached, one started as the
 * parent execution ends can be abandoned on shutdown: the last report of a run is the one that
 * can go missing. That trade is deliberate — the alternative is the agent waiting on a table
 * write.
 *
 * A failure here never propagates. Losing a metric is a nuisance; losing the answer the user
 * paid for is not.
 */
export function createUsageReporter(
	ctx: ISupplyDataFunctions,
	workflowId: string,
	debug: DebugLogger,
): UsageReporter | undefined {
	if (!workflowId) return undefined;

	return async (report: IDataObject) => {
		try {
			await ctx.executeWorkflow({ id: workflowId }, [{ json: report }], undefined, {
				doNotWaitToFinish: true,
			});
		} catch (error) {
			debug.error('Usage report failed (the run itself is unaffected)', {
				workflowId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
}
