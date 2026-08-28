import type { Logger } from 'n8n-workflow';

/**
 * Debug logging, gated once instead of at every call site.
 *
 * The Claude Code node wrapped roughly thirty log calls in `if (additionalOptions.debug)`, which
 * put a logging concern inside every piece of logic worth extracting — the message loop was about
 * half logging by line count. Gating once means the business code just calls `debug.log(...)` and
 * the no-op case costs a function call.
 *
 * `meta` is taken as a thunk on the heavy path so building a payload nobody will log — mapping
 * every message type, slicing a transcript — does not happen when debug is off.
 */

export type DebugLogger = {
	readonly enabled: boolean;
	log: (message: string, meta?: object) => void;
	/** For payloads that cost something to build. The thunk runs only when debug is on. */
	lazy: (message: string, meta: () => object) => void;
	/** Errors are reported whether or not debug is on — they are not diagnostics. */
	error: (message: string, meta?: object) => void;
};

const NOOP_LOG = (): void => {};

export function createDebugLogger(logger: Logger, enabled: boolean): DebugLogger {
	if (!enabled) {
		return {
			enabled: false,
			log: NOOP_LOG,
			lazy: NOOP_LOG,
			error: (message, meta) => logger.error(message, meta as never),
		};
	}
	return {
		enabled: true,
		log: (message, meta) => logger.debug(message, meta as never),
		lazy: (message, meta) => logger.debug(message, meta() as never),
		error: (message, meta) => logger.error(message, meta as never),
	};
}
