import { query } from '@anthropic-ai/claude-agent-sdk';
import { createPromptStream } from '../ClaudeCode/promptStream';

/**
 * The control request behind the CLI's `/usage`. The name is the SDK's own warning label — it is
 * documented as unstable and free to disappear in any release — so it is read off the object rather
 * than called directly, and its absence degrades to `unsupported` instead of throwing.
 */
const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

/** Which control request was in flight when the deadline hit — the useful half of a timeout. */
export type UsageStage = 'spawn' | 'initialize' | 'usage';

export class UsageReadTimeoutError extends Error {
	constructor(
		readonly stage: UsageStage,
		readonly timeoutMs: number,
	) {
		super(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the ${stage} step`);
		this.name = 'UsageReadTimeoutError';
	}
}

export type UsageReadOptions = {
	cwd?: string;
	timeoutMs: number;
	pathToClaudeCodeExecutable?: string;
};

export type UsageReadResult = {
	init: Record<string, unknown> | null;
	usage: Record<string, unknown> | null;
	/** Only ever set if the CLI happens to emit a system init message; no turn means it usually does not. */
	claudeCodeVersion: string | null;
	initMs: number | null;
	usageMs: number | null;
	unsupported: boolean;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const elapsedMsSince = (startedAt: bigint): number =>
	Number(process.hrtime.bigint() - startedAt) / 1e6;

/**
 * Opens a session, asks it who it is and how much of the plan is left, and closes it. No user turn
 * is ever pushed, so the read costs nothing: measured on 0.3.202 the session reports
 * `total_cost_usd: 0` and no assistant message.
 *
 * The session is closed and aborted in `finally`, and this function never returns from inside the
 * `try`. n8n is long-lived — a CLI process leaked once per execution compounds until the container
 * dies, which is the worst failure this node could have.
 */
export async function readUsage(options: UsageReadOptions): Promise<UsageReadResult> {
	const result: UsageReadResult = {
		init: null,
		usage: null,
		claudeCodeVersion: null,
		initMs: null,
		usageMs: null,
		unsupported: false,
	};

	// No initial prompt: the stream keeps the session open for the control requests without ever
	// yielding a turn to answer.
	const promptStream = createPromptStream();
	const abortController = new AbortController();
	let stage: UsageStage = 'spawn';
	let timer: NodeJS.Timeout | undefined;

	const runningQuery = query({
		prompt: promptStream.stream,
		options: {
			abortController,
			...(options.cwd ? { cwd: options.cwd } : {}),
			...(options.pathToClaudeCodeExecutable
				? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }
				: {}),
		},
	});

	// Kept consuming in the background: the control responses arrive on the same transport as the
	// message stream, and an unread stream is a stalled read. Nothing here needs the messages
	// themselves — except the version, if the CLI volunteers it.
	const drained = (async () => {
		for await (const message of runningQuery) {
			if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') {
				const version = (message as { claude_code_version?: unknown }).claude_code_version;
				if (typeof version === 'string') result.claudeCodeVersion = version;
			}
		}
	})().catch(() => {
		// The abort in `finally` ends this loop by design, and a transport error here is already
		// reported by whichever control request failed.
	});

	try {
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				abortController.abort();
				reject(new UsageReadTimeoutError(stage, options.timeoutMs));
			}, options.timeoutMs);
		});

		stage = 'initialize';
		const initStartedAt = process.hrtime.bigint();
		const init = await Promise.race([runningQuery.initializationResult(), deadline]);
		result.initMs = Math.round(elapsedMsSince(initStartedAt));
		result.init = asRecord(init);

		const readUsagePayload = (runningQuery as unknown as Record<string, unknown>)[USAGE_METHOD];
		if (typeof readUsagePayload !== 'function') {
			// The SDK dropped or renamed the request. The account data is still worth returning.
			result.unsupported = true;
		} else {
			stage = 'usage';
			const usageStartedAt = process.hrtime.bigint();
			const usage = await Promise.race([
				(readUsagePayload as () => Promise<unknown>).call(runningQuery),
				deadline,
			]);
			result.usageMs = Math.round(elapsedMsSince(usageStartedAt));
			result.usage = asRecord(usage);
		}
	} finally {
		if (timer) clearTimeout(timer);
		promptStream.close();
		abortController.abort();
		await drained;
	}

	return result;
}
