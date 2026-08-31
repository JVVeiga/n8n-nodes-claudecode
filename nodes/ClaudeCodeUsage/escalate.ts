import {
	PROBE_PROMPT,
	PROFILE_SCOPES,
	type readUsage as realReadUsage,
	type UsageReadOptions,
	type UsageReadResult,
} from './readUsage';
import { normalizeUsage, shouldRetryWithProfileScope } from './usage';

/**
 * The three-step read: a plain read, a scope-declared retry, and — only when opted in — one
 * trivial paid probe.
 *
 * It lived inside `readUsageItems` and was restated in the Usage Tool, where it promptly drifted:
 * the copy stamped `Date.now()` three separate times, so the timestamp every countdown is derived
 * from described a read that had finished seconds earlier. One implementation, one clock.
 *
 * `fetchedAtMs` is captured WITH the read that produced it, which is the whole reason the node
 * caches the pair rather than the payload alone.
 */

export type UsageEscalationOptions = {
	declareProfileScope: boolean;
	probeIfUnavailable: boolean;
};

export type EscalatedRead = {
	raw: UsageReadResult;
	fetchedAtMs: number;
	/** True when the scope-declared retry was made — worth reporting, it changes what the numbers
	 * mean. */
	scopeRetried: boolean;
};

export async function escalateUsageRead(
	readUsage: typeof realReadUsage,
	readOptions: UsageReadOptions,
	options: UsageEscalationOptions,
): Promise<EscalatedRead> {
	const raw = await readUsage(readOptions);
	const done = (result: UsageReadResult, scopeRetried: boolean): EscalatedRead => ({
		raw: result,
		fetchedAtMs: Date.now(),
		scopeRetried,
	});

	if (!options.declareProfileScope) return done(raw, false);
	if (!shouldRetryWithProfileScope(normalizeUsage({ ...raw, fetchedAtMs: Date.now() }))) {
		return done(raw, false);
	}

	// A token session is told it may only infer, so the CLI never asks about plan limits. Ask
	// again with the scope declared; if the token really cannot read the profile the second read
	// returns no windows and nothing is lost but ~0.5s.
	const retried = await readUsage({ ...readOptions, oauthScopes: PROFILE_SCOPES });
	const afterRetry = normalizeUsage({ ...retried, fetchedAtMs: Date.now() });
	if (!options.probeIfUnavailable || afterRetry.rateLimitsAvailable) return done(retried, true);

	// Last resort, and the only route left for an inference-only token: send one trivial turn so
	// the API response carries the rate-limit headers, which the CLI reports as seeded
	// utilisation. This one costs money — a fraction of a cent — which is why it is opt-in.
	const probed = await readUsage({
		...readOptions,
		oauthScopes: PROFILE_SCOPES,
		probePrompt: PROBE_PROMPT,
	});
	return done(probed, true);
}

/** The diagnostics a caller must stamp onto the report so a reader can tell what the read cost
 * and how it was obtained. Shared so the node and the tool cannot report different things. */
export function applyReadDiagnostics(
	report: { diagnostics: Record<string, unknown> },
	read: EscalatedRead,
): void {
	if (read.scopeRetried) report.diagnostics.scopeRetried = true;
	if (read.raw.probeCostUsd !== null) {
		report.diagnostics.probed = true;
		report.diagnostics.probeCostUsd = read.raw.probeCostUsd;
	}
}
