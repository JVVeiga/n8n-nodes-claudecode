import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { queryImpl } from '../../nodes/ClaudeCode/ClaudeCode.node';

/**
 * A stand-in for the SDK's `query()`. Yields a scripted message stream and records the options it
 * was called with, so a test can drive a full run without spawning a CLI or spending money.
 */

export type FakeQueryOptions = {
	/** Messages to yield, in order. */
	messages?: SDKMessage[];
	/** Reject after yielding everything, simulating a generator that throws. */
	throwAfter?: Error;
	/** Never end: yield the scripted messages then hang, so the timeout timers fire. */
	hang?: boolean;
	/** Make `interrupt()` itself reject, which the node must swallow. */
	interruptThrows?: boolean;
	/**
	 * Stop the stream when this is aborted, the way the real SDK does. Without it a `hang` stream
	 * runs forever: the hard timer aborts the controller and nothing notices.
	 */
	abortSignal?: AbortSignal;
	/**
	 * Messages to yield after `interrupt()` is called — the wrap-up turn. Only reachable when
	 * `hang` is set, because otherwise the stream ends before the soft timer fires.
	 */
	afterInterrupt?: SDKMessage[];
};

export type FakeQueryRecord = {
	/** Every options object `query()` was called with. */
	calls: unknown[];
	interruptCount: number;
	/** Resolves once the stream has been fully consumed. */
	iterated: boolean;
};

type QueryArgs = { options?: { abortController?: AbortController } };

export type FakeQueryHandle = {
	fake: typeof queryImpl.query;
	record: FakeQueryRecord;
};

export function createFakeQuery(options: FakeQueryOptions = {}): FakeQueryHandle {
	const record: FakeQueryRecord = { calls: [], interruptCount: 0, iterated: false };
	const messages = options.messages ?? [];

	const fake = ((args: unknown) => {
		record.calls.push(args);

		let interrupted = false;
		const pending: SDKMessage[] = [];

		async function* stream(): AsyncGenerator<SDKMessage> {
			for (const message of messages) {
				yield message;
			}
			if (options.throwAfter) throw options.throwAfter;
			if (!options.hang) {
				record.iterated = true;
				return;
			}
			// Stay open so the wrap-up and hard-abort timers can fire, then stop when the abort
			// lands — which is what the real SDK does, and what makes the loop terminable.
			const signal = options.abortSignal ?? (args as QueryArgs)?.options?.abortController?.signal;
			while (!signal?.aborted) {
				if (interrupted && pending.length > 0) {
					while (pending.length > 0) yield pending.shift() as SDKMessage;
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		}

		const iterator = stream();
		return {
			[Symbol.asyncIterator]: () => iterator,
			next: () => iterator.next(),
			return: (value?: unknown) => iterator.return(value as never),
			throw: (e?: unknown) => iterator.throw(e),
			interrupt: async () => {
				record.interruptCount++;
				if (options.interruptThrows) throw new Error('interrupt failed');
				interrupted = true;
				pending.push(...(options.afterInterrupt ?? []));
			},
			setPermissionMode: async () => {},
			setModel: async () => {},
			supportedCommands: async () => [],
			supportedModels: async () => [],
			mcpServerStatus: async () => ({}),
		} as unknown as ReturnType<typeof queryImpl.query>;
	}) as typeof queryImpl.query;

	return { fake, record };
}

/**
 * Swaps `query` for the duration of `body`, then puts the real one back even if the body throws.
 * The node's module-level indirection is the only seam available until runner.ts lands.
 */
export async function withFakeQuery<T>(
	options: FakeQueryOptions,
	body: (record: FakeQueryRecord) => Promise<T>,
): Promise<T> {
	const { fake, record } = createFakeQuery(options);
	const real = queryImpl.query;
	queryImpl.query = fake;
	try {
		return await body(record);
	} finally {
		queryImpl.query = real;
	}
}
