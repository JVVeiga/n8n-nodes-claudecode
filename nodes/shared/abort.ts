/**
 * Wiring an operation's AbortController to signals that outlive it.
 *
 * A sub-node reads `getExecutionCancelSignal()` ONCE, in `supplyData`, and the object it returns
 * is then shared by every call the Agent makes on that model or tool. Adding a listener per call
 * without removing it accumulates one dead `AbortController` per agent step, and Node starts
 * warning about a leak past ten. So the attachment is scoped: attach, then detach in a `finally`.
 *
 * An already-aborted signal fires immediately rather than waiting for an event that will never
 * come again.
 */

export type AbortAttachment = { detach: () => void };

export function attachAbort(
	signals: Array<AbortSignal | undefined>,
	abort: () => void,
): AbortAttachment {
	const attached: AbortSignal[] = [];

	for (const signal of signals) {
		if (!signal) continue;
		if (signal.aborted) {
			abort();
			continue;
		}
		signal.addEventListener('abort', abort, { once: true });
		attached.push(signal);
	}

	return {
		detach: () => {
			for (const signal of attached) signal.removeEventListener('abort', abort);
			attached.length = 0;
		},
	};
}
