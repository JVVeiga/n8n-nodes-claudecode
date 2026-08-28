import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { DebugLogger } from '../shared/debug';
import { isResult } from '../shared/sdkMessage';
import { logMessage } from './messageLog';
import type { PromptStream } from './promptStream';
import type { GraceWindow, TerminationReason } from './timeout';
import type { QueryOptions, RunOutcome } from './types';

/**
 * Running the query, and stopping it.
 *
 * The choreography here is the subtlest thing in the node, and all of it is load-bearing:
 *
 * Interrupting is what makes the SDK ACCOUNT for a run. `interrupt()` produces a result message
 * within ~100ms carrying the cumulative cost, tokens and session id. A plain `abort()` emits
 * nothing at all — which is why a timed-out run used to report zeroes and look free.
 *
 * So a timeout has two stages. The soft timer interrupts and asks for a handover; the hard timer
 * aborts unconditionally, because a wrap-up turn that hangs must not push the run past the timeout
 * the workflow author configured.
 *
 * A graceful timeout also emits TWO result messages: the interrupt's own, then the wrap-up's. Until
 * the wrap-up is requested, one result means the run is over; after it, the FIRST result is the
 * interrupt's and the stream has to stay open for the summary that follows.
 *
 * This function never throws for a timeout. It reports `timedOut` and lets the caller decide
 * whether that becomes an error item or an exception — which is what removed the nested
 * try/catch/finally from execute().
 */

/** Sent as a normal user turn after the interrupt, to get a handover rather than more work. */
export const WRAP_UP_PROMPT = [
	'Your time budget for this task is exhausted. Stop all work now.',
	'Do not start new tasks, do not call tools, do not edit files.',
	'Reply with, in this order:',
	'1. What you completed.',
	'2. What is incomplete or in progress.',
	'3. The exact next steps to resume.',
	'4. Any file paths, IDs, or state a follow-up run needs.',
	'Be concise and factual. Do not apologise.',
].join('\n');

export type RunInput = {
	queryOptions: QueryOptions;
	graceWindow: GraceWindow;
	promptStream: PromptStream;
	abortController: AbortController;
	/** Injected so a test can drive the stream without spawning a CLI. */
	query: typeof sdkQuery;
	debug: DebugLogger;
	/** Injected so a test can assert durations without waiting for a clock. */
	now?: () => number;
	/**
	 * The array the caller also holds. Messages are pushed as they arrive rather than returned at
	 * the end, so every error path can report what had arrived before it failed.
	 */
	messages: SDKMessage[];
	/**
	 * Reads the effort level Claude Code reported applying. The value is written by a hook that
	 * config.ts registered, so the run loop can only ask for it — it never sees the hook itself.
	 */
	getAppliedEffort?: () => string | undefined;
};

export async function runQuery(input: RunInput): Promise<RunOutcome> {
	const { queryOptions, graceWindow, promptStream, abortController, debug, messages } = input;
	const now = input.now ?? Date.now;
	const startedAt = now();

	let timedOut = false;
	let terminationReason: TerminationReason | null = null;
	let wrapUpSucceeded = false;
	let error: unknown = null;

	// Held in a variable rather than iterated inline so control requests can reach it.
	const runningQuery = input.query(queryOptions);

	let wrapUpRequested = false;
	let resultsSinceInterrupt = 0;
	let streamClosed = false;

	const closeStream = () => {
		streamClosed = true;
		promptStream.close();
	};

	const wrapUpTimer =
		graceWindow.wrapUpAtMs === null
			? undefined
			: setTimeout(() => {
					// The run may have finished in the meantime. The SDK emits no result message until a
					// turn ends, so one already present means there is nothing left to interrupt — bail
					// out rather than bill a wrap-up turn and report a completed run as a timeout.
					if (streamClosed || messages.some(isResult)) return;

					timedOut = true;
					terminationReason = 'timeout_graceful';
					wrapUpRequested = true;

					void (async () => {
						try {
							await runningQuery.interrupt();
						} catch (interruptError) {
							// Best effort — the hard timer is the backstop.
							debug.log('Interrupt failed', {
								error: interruptError instanceof Error ? interruptError.message : 'unknown',
							});
						}
						promptStream.push(WRAP_UP_PROMPT);
					})();
				}, graceWindow.wrapUpAtMs);

	// Always armed, whatever the grace.
	const hardTimer = setTimeout(() => {
		timedOut = true;
		if (terminationReason === null) terminationReason = 'timeout_hard_abort';
		abortController.abort();
	}, graceWindow.hardAbortAtMs);

	try {
		for await (const message of runningQuery) {
			messages.push(message);

			// In streaming input mode the session stays open while the input stream is open, so the
			// result message is the signal to close it. Without this the query would never end.
			if (isResult(message)) {
				if (!wrapUpRequested) {
					closeStream();
				} else if (++resultsSinceInterrupt >= 2) {
					// First result was the interrupt's; this one is the summary.
					wrapUpSucceeded = true;
					closeStream();
				}
			}

			logMessage(debug, message);
		}
	} catch (caught) {
		// The SDK delivers the result message before rejecting, so `messages` may already hold the
		// spend and session data. Reported, not thrown — the caller decides what it means.
		error = caught;
	} finally {
		clearTimeout(hardTimer);
		if (wrapUpTimer !== undefined) clearTimeout(wrapUpTimer);
		// On an error path the loop stops consuming while the input generator is still suspended
		// waiting for a follow-up turn. Closing releases it.
		promptStream.close();
	}

	if (debug.enabled && timedOut) {
		debug.log('Run timed out', {
			terminationReason,
			wrapUpSucceeded,
			wrapUpGraceSeconds: graceWindow.graceSeconds,
			resultMessages: messages.filter(isResult).length,
		});
	}

	return {
		messages,
		timedOut,
		terminationReason,
		wrapUpSucceeded,
		durationMs: now() - startedAt,
		appliedEffort: input.getAppliedEffort?.() ?? null,
		error,
	};
}
