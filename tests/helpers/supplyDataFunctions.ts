import type { ISupplyDataFunctions } from 'n8n-workflow';
import { createFakeContext, type FakeContext, type FakeContextOptions } from './executeFunctions';

/**
 * A test double for the slice of `ISupplyDataFunctions` the sub-nodes touch.
 *
 * Like its execute-context sibling, anything NOT modelled here throws rather than resolving to
 * `undefined` — a double that silently answers `undefined` lets a test pass on a member the node
 * would have found missing in production. The first version of this file inherited from the base
 * context with `Object.create`, which quietly did exactly that.
 */

export type RunDataEntry = {
	direction: 'input' | 'output';
	index: number;
	payload: unknown;
};

export type FakeSupplyContextOptions = FakeContextOptions & {
	/** Ids reported by getExecutionId/getWorkflow, which end up in a usage report's run_key. */
	executionId?: string;
	workflowId?: string;
	/** Make executeWorkflow reject, to prove a reporting failure never fails the run. */
	executeWorkflowThrows?: boolean;
	/** Make `addInputData` throw, the way n8n does outside a real execution (an editor probe).
	 * The nodes are supposed to degrade to no logging and still work. */
	addInputDataThrows?: boolean;
	/** Model an n8n build that does not expose the cancel signal at all. */
	withoutCancelSignal?: boolean;
};

export type WorkflowCall = { workflowId: string; payload: unknown; doNotWaitToFinish?: boolean };

export type FakeSupplyContext = FakeContext & {
	supplyCtx: ISupplyDataFunctions;
	/** Every addInputData/addOutputData call, in order. */
	runData: RunDataEntry[];
	/** The signal handed to `getExecutionCancelSignal`. Abort it to simulate a cancel. */
	cancelController: AbortController;
	/** Every executeWorkflow call — how a sub-node reports usage. */
	workflowCalls: WorkflowCall[];
};

const NOT_IMPLEMENTED = (name: string) => () => {
	throw new Error(
		`FakeSupplyDataFunctions: ${name}() is not implemented. The node reached for a member the ` +
			`double does not model — add it to tests/helpers/supplyDataFunctions.ts deliberately, ` +
			`rather than letting the test pass on an undefined.`,
	);
};

export function createFakeSupplyContext(options: FakeSupplyContextOptions = {}): FakeSupplyContext {
	const base = createFakeContext(options);
	const runData: RunDataEntry[] = [];
	const workflowCalls: WorkflowCall[] = [];
	const cancelController = new AbortController();
	let nextIndex = 0;

	const modelled: Record<string, unknown> = {
		// Shared with the execute context — same behaviour, deliberately not re-implemented.
		getNodeParameter: base.ctx.getNodeParameter.bind(base.ctx),
		getCredentials: base.ctx.getCredentials.bind(base.ctx),
		getNode: base.ctx.getNode.bind(base.ctx),
		logger: base.ctx.logger,
		continueOnFail: base.ctx.continueOnFail.bind(base.ctx),
		helpers: base.ctx.helpers,

		// Supply-data's own surface.
		getMode: () => 'manual',
		getExecutionId: () => options.executionId ?? 'exec-1',
		getWorkflow: () => ({ id: options.workflowId ?? 'wf-1', name: 'Fake', active: false }),
		executeWorkflow: async (
			info: { id?: string },
			inputData?: Array<{ json: unknown }>,
			_cb?: unknown,
			execOptions?: { doNotWaitToFinish?: boolean },
		) => {
			if (options.executeWorkflowThrows) throw new Error('collector workflow is unavailable');
			workflowCalls.push({
				workflowId: info.id ?? '',
				payload: inputData?.[0]?.json,
				doNotWaitToFinish: execOptions?.doNotWaitToFinish,
			});
			return { data: [], executionId: 'sub-1' };
		},
		...(options.withoutCancelSignal
			? {}
			: { getExecutionCancelSignal: () => cancelController.signal }),
		addInputData: (_connectionType: string, data: unknown) => {
			if (options.addInputDataThrows) {
				throw new Error('addInputData is not available outside an execution');
			}
			const index = nextIndex++;
			runData.push({ direction: 'input', index, payload: data });
			return { index };
		},
		addOutputData: (_connectionType: string, index: number, data: unknown) => {
			runData.push({ direction: 'output', index, payload: data });
		},
	};

	// Members the caller asked to REMOVE resolve to undefined, the way an n8n build that does not
	// expose them behaves — the node guards those with `?.()`. Everything else that is simply not
	// modelled throws, so a test cannot pass on a member production would have found missing.
	const deliberatelyAbsent = new Set<string>(
		options.withoutCancelSignal ? ['getExecutionCancelSignal'] : [],
	);

	const supplyCtx = new Proxy(modelled, {
		get: (target, prop) => {
			if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
			if (deliberatelyAbsent.has(String(prop))) return undefined;
			return NOT_IMPLEMENTED(String(prop));
		},
	}) as unknown as ISupplyDataFunctions;

	return { ...base, supplyCtx, runData, cancelController, workflowCalls };
}
