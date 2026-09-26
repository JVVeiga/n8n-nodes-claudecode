import type { IDataObject } from 'n8n-workflow';
import type { OutputFormat, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { DebugLogger } from '../../shared/debug';
import { findInit, lastResult } from '../../shared/sdkMessage';
import { buildRunMetrics } from '../../ClaudeCode/output/metrics';
import type { RunOutcome } from '../../ClaudeCode/types';
import type { VerificationParams } from '../params';
import { extractStructured } from '../structured';
import type { Attempt, TurnRunner } from '../turn';
import {
	applyVerdict,
	failedReport,
	parseVerdict,
	skippedReport,
	type VerificationReport,
} from './apply';
import { combineVerificationMetrics } from './metrics';
import { VERDICT_SCHEMA, verifierTurn } from './prompt';
import { selectItems } from './select';

export type VerifierTurn = { resume: string; content: string; outputFormat: OutputFormat };

export type VerificationOutcome<T> = {
	structured: unknown;
	report: VerificationReport;
	/** The verification run, when one was started. */
	attempt: T | null;
};

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * Checks the selected items in a fork of the main run's session. Nothing here fails the
 * item: whatever goes wrong, the answer already paid for is kept unverified and marked failed.
 */
export async function verifyStructured<
	T extends { run: RunOutcome; sdkMessages: SDKMessage[] },
>(input: {
	verification: VerificationParams;
	structured: unknown;
	sessionId: string | null;
	timeoutSeconds: number;
	runTurn: (turn: VerifierTurn) => Promise<T>;
}): Promise<VerificationOutcome<T>> {
	const { verification, structured } = input;
	const unverified = (reason: string, checked: number, attempt: T | null = null) => ({
		structured,
		report: failedReport(reason, checked),
		attempt,
	});

	const selection = selectItems(structured, verification.itemsPath, verification.filter);
	if ('problem' in selection) return unverified(selection.problem.message, 0);
	const checked = selection.indices.length;
	if (checked === 0) return { structured, report: skippedReport(), attempt: null };
	if (!input.sessionId) return unverified('the main run reported no session to resume', checked);

	let attempt: T;
	try {
		attempt = await input.runTurn({
			resume: input.sessionId,
			content: verifierTurn(verification.instructions, selection.items, selection.indices),
			outputFormat: { type: 'json_schema', schema: VERDICT_SCHEMA },
		});
	} catch (error) {
		return unverified(`the verification run could not start: ${messageOf(error)}`, checked);
	}

	const { run } = attempt;
	if (run.timedOut) {
		return unverified(
			`the verification run timed out after ${input.timeoutSeconds}s`,
			checked,
			attempt,
		);
	}
	const outcome = extractStructured(attempt.sdkMessages);
	if ('failure' in outcome) {
		const reason =
			run.error !== null && !lastResult(attempt.sdkMessages)
				? messageOf(run.error)
				: outcome.failure;
		return unverified(`the verification run failed: ${reason}`, checked, attempt);
	}
	const verdict = parseVerdict(outcome.ok);
	if (!verdict) return unverified('the verdict did not match its schema', checked, attempt);

	const applied = applyVerdict(structured, verification.itemsPath, selection.indices, verdict);
	return { ...applied, attempt };
}

/**
 * Verification for one item: the fork, the item's metrics counting both runs, and the report with
 * the verification's own cost. `metrics` is null when no verification run started.
 */
export async function runVerification(input: {
	verification: VerificationParams;
	structured: unknown;
	messages: SDKMessage[];
	durationMs: number;
	timeoutSeconds: number;
	runTurn: TurnRunner;
	/** Called with the verification run, when one started. */
	onAttempt: (attempt: Attempt) => void;
	debug: DebugLogger;
}): Promise<{ structured: unknown; report: IDataObject; metrics: IDataObject | null }> {
	const { messages, timeoutSeconds } = input;
	const verified = await verifyStructured({
		verification: input.verification,
		structured: input.structured,
		sessionId: lastResult(messages)?.session_id ?? findInit(messages)?.session_id ?? null,
		timeoutSeconds,
		runTurn: (turn) =>
			input.runTurn(
				{ resume: turn.resume },
				{ timeoutSeconds },
				{
					content: turn.content,
					outputFormat: turn.outputFormat,
					label: 'Starting Claude Code Agent verification run',
					// A fork, so the next execution with this Session Key continues after the
					// main run's answer, not after the verifier's turn.
					forkSession: true,
				},
				[],
			),
	});

	let costUsd: number | null = 0;
	let metrics: IDataObject | null = null;
	if (verified.attempt) {
		input.onAttempt(verified.attempt);
		const combined = combineVerificationMetrics(
			buildRunMetrics(messages, input.durationMs),
			buildRunMetrics(verified.attempt.sdkMessages, verified.attempt.run.durationMs),
		);
		metrics = combined.metrics;
		costUsd = combined.costUsd;
	}
	input.debug.log('Verification finished', {
		status: verified.report.status,
		reason: verified.report.reason,
		checked: verified.report.checked,
		kept: verified.report.kept,
		dropped: verified.report.dropped,
		unjudged: verified.report.unjudged,
		costUsd,
	});
	return { structured: verified.structured, report: { ...verified.report, costUsd }, metrics };
}
