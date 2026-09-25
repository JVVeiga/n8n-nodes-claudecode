import { createHash } from 'node:crypto';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { DebugLogger } from './debug';
import { assistantMessages, findResult } from './sdkMessage';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Session ID parameter accepts either a real session UUID (the round-trip style) or ANY
 * stable conversation key — `discord:8463…`, a phone number, a ticket id. A key is hashed into a
 * deterministic UUID (v5-shaped: SHA-1, version and variant bits set), because the SDK requires
 * a valid UUID and because determinism is the whole point: the same key always names the same
 * session, so nothing anywhere has to store a mapping.
 */
export function toSessionUuid(sessionIdOrKey: string): string {
	if (UUID_RE.test(sessionIdOrKey)) return sessionIdOrKey.toLowerCase();
	const hash = createHash('sha1')
		.update('n8n-nodes-claudecode/chat-model-session/')
		.update(sessionIdOrKey)
		.digest('hex');
	const bytes = hash.slice(0, 32).split('');
	bytes[12] = '5'; // version 5
	bytes[16] = ((parseInt(bytes[16], 16) & 0x3) | 0x8).toString(16); // RFC 4122 variant
	const h = bytes.join('');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** `resume` continues an existing session; `create` starts one under the deterministic id (the
 * SDK's `sessionId` option); null is a plain anonymous session. */
export type SessionRequest = { resume: string } | { create: string } | null;

export type SessionState = 'new' | 'resumed' | 'created';

/** The slice of one CLI run the session logic reads. */
export type SessionAttempt = {
	run: { error: unknown; timedOut: boolean };
	sdkMessages: SDKMessage[];
};

/** True when an attempt hit the session-not-found outcome. Measured twice, because it has
 * TWO shapes: the generator rejects with "No conversation found with session ID: …"
 * (what the runner reports as `run.error` — seen on case65c), and, when the stream is
 * abandoned before the rejection lands, a silent `error_during_execution` result with
 * zero assistant turns (the original spike, which broke out of the loop early and
 * therefore only saw this one). */
export function resumeFoundNothing(attempt: SessionAttempt): boolean {
	if (attempt.run.timedOut) return false;
	if (attempt.run.error !== null) {
		const text =
			attempt.run.error instanceof Error ? attempt.run.error.message : String(attempt.run.error);
		return /No conversation found with session ID/i.test(text);
	}
	// The silent shape: an error result with no assistant turn at all. Narrowed with
	// `num_turns` because any early failure — an auth refusal, a CLI crash — wears the same
	// subtype, and treating those as "session missing" bills a second pointless run and
	// then blames the container's disk for something else entirely.
	const result = findResult(attempt.sdkMessages) as
		| { subtype?: string; num_turns?: number }
		| undefined;
	return (
		assistantMessages(attempt.sdkMessages).length === 0 &&
		result?.subtype === 'error_during_execution' &&
		(result.num_turns ?? 0) === 0
	);
}

export type SessionRunOptions = {
	/** The deterministic session id, or null for an anonymous run. */
	sessionUuid: string | null;
	/** The configured timeout, shared by every attempt. */
	timeoutSeconds: number;
	/** When the budget started; defaults to the call of runWithSession. */
	startedAt?: number;
	now?: () => number;
	debug?: DebugLogger;
};

export type SessionRun<T extends SessionAttempt> = {
	attempt: T;
	state: SessionState;
	/** The create attempt also found nothing: the session can neither be resumed nor made. */
	unrecoverable: boolean;
};

/**
 * Resume under the session id; when that finds nothing, create the session under the SAME id and
 * run again. That is what makes a stable conversation key work with no storage anywhere.
 *
 * One budget for both attempts: `runOnce` arms its timers from the start of EACH run, so without
 * this a 300s node could occupy 600s of wall clock. Each attempt gets what is left, floored at 5s
 * so it is never born expired.
 */
export async function runWithSession<T extends SessionAttempt>(
	runOnce: (session: SessionRequest, budget: { timeoutSeconds: number }) => Promise<T>,
	options: SessionRunOptions,
): Promise<SessionRun<T>> {
	const now = options.now ?? Date.now;
	const startedAt = options.startedAt ?? now();
	const budget = () => {
		const elapsedSeconds = Math.floor((now() - startedAt) / 1000);
		return { timeoutSeconds: Math.max(5, options.timeoutSeconds - elapsedSeconds) };
	};
	const { sessionUuid } = options;

	const attempt = await runOnce(sessionUuid ? { resume: sessionUuid } : null, budget());
	if (!sessionUuid) return { attempt, state: 'new', unrecoverable: false };
	if (!resumeFoundNothing(attempt)) return { attempt, state: 'resumed', unrecoverable: false };

	options.debug?.log('Session not found — creating it under the deterministic id', {
		sessionUuid,
	});
	const created = await runOnce({ create: sessionUuid }, budget());
	return { attempt: created, state: 'created', unrecoverable: resumeFoundNothing(created) };
}
