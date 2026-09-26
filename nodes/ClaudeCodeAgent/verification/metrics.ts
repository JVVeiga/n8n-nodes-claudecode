import type { IDataObject } from 'n8n-workflow';

const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);

const sum = (a: number | null, b: number | null): number | null =>
	a === null ? b : b === null ? a : a + b;

/** Rounded so a subtraction of two costs does not print as 0.0017460000000000002. */
const round = (value: number): number => Math.round(value * 1e10) / 1e10;

/**
 * The item's metrics when a verification run resumed the main run's session. A resumed result's
 * `total_cost_usd` and `modelUsage` already include the session's earlier runs, while
 * `num_turns`, `duration_ms` and `usage` cover that query alone.
 */
export function combineVerificationMetrics(
	main: IDataObject,
	verification: IDataObject,
): { metrics: IDataObject; costUsd: number | null } {
	const mainCost = num(main.total_cost_usd);
	const sessionCost = num(verification.total_cost_usd);
	return {
		metrics: {
			...main,
			duration_ms: sum(num(main.duration_ms), num(verification.duration_ms)),
			num_turns: sum(num(main.num_turns), num(verification.num_turns)),
			total_cost_usd: sessionCost ?? mainCost,
			modelUsage: verification.modelUsage ?? main.modelUsage ?? null,
		},
		costUsd: sessionCost !== null && mainCost !== null ? round(sessionCost - mainCost) : null,
	};
}
