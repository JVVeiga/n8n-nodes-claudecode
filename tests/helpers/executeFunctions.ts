import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

/**
 * A test double for the slice of `IExecuteFunctions` these two nodes actually touch.
 *
 * n8n's real context object is enormous and wired to a running workflow. The nodes use seven
 * members of it, listed below; anything else deliberately throws rather than returning undefined,
 * so a future node change that reaches for a new member fails loudly here instead of silently
 * doing nothing in a test.
 */

export type ParamMap = Record<string, unknown>;

export type FakeContextOptions = {
	/** Input items. Defaults to a single empty item. */
	items?: INodeExecutionData[];
	/** Parameter values by name. A function is called with (itemIndex) for per-item values. */
	params?: ParamMap;
	/** `getNode().typeVersion`. Drives the version-aware branches. */
	typeVersion?: number;
	nodeName?: string;
	continueOnFail?: boolean;
};

export type LogEntry = {
	level: 'debug' | 'info' | 'warn' | 'error';
	message: string;
	meta?: object;
};

export type FakeContext = {
	/** Pass this where an `IExecuteFunctions` is expected. */
	ctx: IExecuteFunctions;
	/** Every logger call, in order. */
	logs: LogEntry[];
	/** Callbacks registered via `onExecutionCancellation`. Call `cancel()` to fire them. */
	cancel: () => void;
	/** Names of parameters that were read, in order — proves a param is actually consumed. */
	reads: string[];
	/** Replace a parameter mid-test (e.g. between items). */
	setParam: (name: string, value: unknown) => void;
	logsFor: (level: LogEntry['level']) => LogEntry[];
};

const NOT_IMPLEMENTED = (name: string) => () => {
	throw new Error(
		`FakeExecuteFunctions: ${name}() is not implemented. The node reached for a member the ` +
			`double does not model — add it to tests/helpers/executeFunctions.ts deliberately, ` +
			`rather than letting the test pass on an undefined.`,
	);
};

export function createFakeContext(options: FakeContextOptions = {}): FakeContext {
	const items: INodeExecutionData[] = options.items ?? [{ json: {} }];
	const params: ParamMap = { ...(options.params ?? {}) };
	const typeVersion = options.typeVersion ?? 1.1;
	const nodeName = options.nodeName ?? 'Claude Code';
	const continueOnFail = options.continueOnFail ?? false;

	const logs: LogEntry[] = [];
	const reads: string[] = [];
	const cancellationCallbacks: Array<() => void> = [];

	const log =
		(level: LogEntry['level']) =>
		(message: string, meta?: object): void => {
			logs.push({ level, message, ...(meta === undefined ? {} : { meta }) });
		};

	const node = {
		id: 'fake-node-id',
		name: nodeName,
		type: 'n8n-nodes-claudecode.claudeCode',
		typeVersion,
		position: [0, 0] as [number, number],
		parameters: params,
	};

	const ctx = {
		getInputData: () => items,

		// The real signature resolves an unset parameter to the fallback. A parameter that is
		// neither in the map nor given a fallback is a bug in the test, not an empty value — the
		// node would have got the schema default in production.
		getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) => {
			reads.push(name);
			if (!(name in params)) {
				if (fallback !== undefined) return fallback;
				throw new Error(
					`FakeExecuteFunctions: no value for parameter '${name}' and no fallback given. ` +
						`Add it to the params map.`,
				);
			}
			const value = params[name];
			return typeof value === 'function' ? (value as (i: number) => unknown)(itemIndex) : value;
		},

		getNode: () => node,

		continueOnFail: () => continueOnFail,

		onExecutionCancellation: (cb: () => void) => {
			cancellationCallbacks.push(cb);
		},

		logger: {
			debug: log('debug'),
			info: log('info'),
			warn: log('warn'),
			error: log('error'),
		},

		// Everything else the interface declares but these nodes never call.
		getWorkflow: NOT_IMPLEMENTED('getWorkflow'),
		getCredentials: NOT_IMPLEMENTED('getCredentials'),
		helpers: new Proxy(
			{
				/**
				 * The real helper hides whether n8n stored the bytes inline as base64 or on a
				 * filesystem, which is why the node calls it instead of reading `.data`. The double
				 * models the inline case, because that is the one a test can build — and it decodes
				 * `.data` rather than taking a separate buffer map, so a fixture item looks like the
				 * item an upstream node actually produces.
				 */
				getBinaryDataBuffer: async (itemIndex: number, propName: string): Promise<Buffer> => {
					const entry = items[itemIndex]?.binary?.[propName];
					if (!entry) {
						throw new Error(
							`FakeExecuteFunctions: item ${itemIndex} has no binary property '${propName}'.`,
						);
					}
					return Buffer.from(entry.data, 'base64');
				},
			},
			{
				get: (target, prop) =>
					prop in target
						? (target as Record<string | symbol, unknown>)[prop]
						: NOT_IMPLEMENTED(`helpers.${String(prop)}`),
			},
		),
	} as unknown as IExecuteFunctions;

	return {
		ctx,
		logs,
		reads,
		cancel: () => {
			for (const cb of cancellationCallbacks) cb();
		},
		setParam: (name, value) => {
			params[name] = value;
		},
		logsFor: (level) => logs.filter((l) => l.level === level),
	};
}

/**
 * The `additionalOptions` collection as the node's schema would deliver it. Spelled out here so a
 * test can say `additional({ debug: true })` instead of restating eleven fields.
 */
export const additional = (over: Record<string, unknown> = {}) => ({ ...over });

/**
 * One binary property as n8n delivers it: base64 bytes plus the metadata the node reads to name and
 * route the file. `mimeType` is deliberately optional — an upstream HTTP Request node routinely
 * reports `application/octet-stream` or nothing at all.
 */
export const binaryProperty = (
	content: string | Buffer,
	meta: { fileName?: string; fileExtension?: string; mimeType?: string } = {},
) => ({
	data: (typeof content === 'string' ? Buffer.from(content, 'utf8') : content).toString('base64'),
	...meta,
});

/** An input item carrying binary properties, keyed by property name. */
export const itemWithBinary = (
	binary: Record<string, ReturnType<typeof binaryProperty>>,
	json: IDataObject = {},
): INodeExecutionData => ({ json, binary: binary as never });

/** A parameter map for a minimal, valid Claude Code node. */
export const claudeCodeParams = (over: ParamMap = {}): ParamMap => ({
	operation: 'query',
	prompt: 'Reply with exactly the word: pong.',
	model: 'claude-sonnet-5',
	effort: 'high',
	maxTurns: 5,
	timeout: 300,
	projectPath: '',
	outputFormat: 'structured',
	allowedTools: [],
	disallowedTools: [],
	restrictTools: [],
	additionalOptions: additional(),
	...over,
});
