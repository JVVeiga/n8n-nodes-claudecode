import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { z } from 'zod/v4';
import type { ConfigDeps } from '../ClaudeCode/config';

/**
 * The Option B bridge (DEC-CM1): the tools the Agent bound become one in-process MCP server, and
 * each handler executes the LangChain tool directly — which runs the connected n8n sub-node with
 * its own execution log (spec F-05). Claude therefore runs the Agent's tools itself, inside its
 * own loop, and the Agent sees a model that answered in one turn.
 *
 * Schemas: every structured tool arrives with a zod object (n8n's `normalizeToolSchema` converts
 * JSON schema before the model ever sees it — spike S2), but it is n8n's zod, not ours. Handing a
 * foreign zod instance to the SDK would couple two copies at their least duck-typed seam, so the
 * bridge converts through JSON Schema instead: their zod → JSON Schema (via `@langchain/core`'s
 * own converter, which duck-walks the schema) → a fresh shape built with OUR `zod/v4` — the same
 * import the SDK itself uses. The round-trip is faithful because the schemas were born from JSON
 * Schema in the first place.
 */

export const MCP_SERVER_NAME = 'n8n';

/** n8n's structured-output tool (spec F-15). The bridge registers it like any other tool; the
 * result mapper watches for its call and returns it to the Agent as a real `tool_calls` entry. */
export const FORMAT_TOOL_NAME = 'format_final_json_response';

/** How a bridged tool's name appears to the run — and in Restrict/Allowed Tools. */
export const bridgedToolName = (name: string): string => `mcp__${MCP_SERVER_NAME}__${name}`;

/** The slice of a LangChain tool the bridge touches, named structurally: the instances belong to
 * n8n's `@langchain/core`, so nominal types from ours would be a lie. */
export type BindableTool = {
	name: string;
	description?: string;
	schema?: unknown;
	invoke: (input: unknown) => Promise<unknown>;
	metadata?: Record<string, unknown>;
};

type JsonSchema = {
	type?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	description?: string;
};

const toZodType = (schema: JsonSchema | undefined): z.ZodType => {
	let type: z.ZodType;
	if (!schema || typeof schema !== 'object') {
		type = z.unknown();
	} else if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		// `z.enum` is string-only. Coercing every member with String() told the model to send
		// "2" for `{type:'number', enum:[1,2,3]}`, and the n8n tool's own `z.number()` then
		// rejected it — the tool failed on every call. A literal union keeps the JSON type.
		const literals = schema.enum.map((value) =>
			z.literal(value as string | number | boolean),
		) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]];
		type = schema.enum.every((value) => typeof value === 'string')
			? z.enum(schema.enum as [string, ...string[]])
			: literals.length === 1
				? literals[0]
				: z.union(literals);
	} else {
		switch (schema.type) {
			case 'string':
				type = z.string();
				break;
			case 'number':
			case 'integer':
				type = z.number();
				break;
			case 'boolean':
				type = z.boolean();
				break;
			case 'array':
				type = z.array(toZodType(schema.items));
				break;
			case 'object':
				type = z.object(toShape(schema));
				break;
			default:
				type = z.unknown();
		}
	}
	return schema?.description ? type.describe(schema.description) : type;
};

const toShape = (schema: JsonSchema): Record<string, z.ZodType> => {
	const required = new Set(schema.required ?? []);
	const shape: Record<string, z.ZodType> = {};
	for (const [key, property] of Object.entries(schema.properties ?? {})) {
		const type = toZodType(property);
		shape[key] = required.has(key) ? type : type.optional();
	}
	return shape;
};

/** True when the value quacks like a zod schema — cross-copy, so no instanceof. */
const isZodSchema = (value: unknown): boolean =>
	typeof (value as { safeParse?: unknown })?.safeParse === 'function';

type PlannedTool = {
	name: string;
	description: string;
	shape: Record<string, z.ZodType>;
	/** String-input tools (`DynamicTool`) take the bare string, not the args object. */
	stringInput: boolean;
};

/**
 * Exposed for tests: what the bridge decided about one tool, before any SDK object exists.
 * A tool whose schema cannot be read degrades to string input rather than being dropped — a tool
 * the model cannot call precisely is still better than a tool that silently vanished.
 */
export function planTool(bindable: BindableTool): PlannedTool {
	const fallback: PlannedTool = {
		name: bindable.name,
		description: bindable.description ?? '',
		shape: { input: z.string().describe('The input to pass to the tool') },
		stringInput: true,
	};
	if (bindable.schema === undefined || bindable.schema === null) return fallback;

	let jsonSchema: JsonSchema;
	try {
		jsonSchema = (
			isZodSchema(bindable.schema)
				? // `unrepresentable: 'any'` matters: zod v4's converter THROWS on z.date(),
					// z.bigint(), z.custom() and output-side transforms. Without it one such field
					// dropped the whole tool to string input — the exec-88 failure shape re-entered
					// through a different door.
					toJsonSchema(bindable.schema, { unrepresentable: 'any' })
				: bindable.schema
		) as JsonSchema;
	} catch {
		return fallback;
	}

	if (!jsonSchema || typeof jsonSchema !== 'object' || jsonSchema.type !== 'object') {
		// A `DynamicTool`'s transform-wrapped string schema lands here, as does anything opaque.
		return fallback;
	}
	// An object schema with ZERO properties is a real case, not an opaque one: n8n's
	// node-as-tool (`usableAsTool` — the Usage node, for instance) builds `z.object({})` when
	// the node declares no $fromAI arguments. Treating it as string-input made the handler call
	// `tool.invoke("<text>")`, which fails the tool's own schema parse before its func ever runs
	// — found in the field as "erro de schema inconsistente" with no tool run logged (exec 88).
	// Zero arguments → empty shape, and the handler passes the args object through.

	return {
		name: bindable.name,
		description: bindable.description ?? '',
		shape: toShape(jsonSchema),
		stringInput: false,
	};
}

const asText = (value: unknown): string =>
	typeof value === 'string' ? value : JSON.stringify(value ?? '');

/**
 * Execute one bridged call: unwrap string-input tools, stringify the output, and turn a thrown
 * error into an `isError` result rather than a crashed run. Exported so the tests can drive the
 * exact code the MCP handler runs without standing up an MCP server.
 */
export async function runBindableTool(
	planned: PlannedTool,
	bindable: BindableTool,
	args: unknown,
	onToolError?: (toolName: string, error: unknown) => void,
): Promise<CallToolResult> {
	try {
		const input = planned.stringInput ? ((args as { input?: string }).input ?? '') : args;
		const output = await bindable.invoke(input);
		return { content: [{ type: 'text', text: asText(output) }] };
	} catch (error) {
		onToolError?.(planned.name, error);
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: 'text', text: `Tool ${planned.name} failed: ${message}` }],
			isError: true,
		};
	}
}

export type ToolBridge = NonNullable<ConfigDeps['mcp']>;

/**
 * Build the `deps.mcp` value for `buildQueryOptions`, or null when no tools are bound.
 * `onToolError` observes handler failures for the debug log; the failure itself is returned to
 * Claude as an `isError` result rather than thrown — a tool that crashes the whole run would
 * turn one bad argument into a lost execution.
 */
export function buildToolBridge(
	tools: BindableTool[],
	onToolError?: (toolName: string, error: unknown) => void,
): ToolBridge | null {
	if (tools.length === 0) return null;

	const sdkTools = tools.map((bindable) => {
		const planned = planTool(bindable);
		return tool(
			planned.name,
			planned.description,
			planned.shape,
			async (args): Promise<CallToolResult> =>
				runBindableTool(planned, bindable, args, onToolError),
			// Never deferred behind tool search: the Agent bound these tools deliberately, and a
			// bridged tool the model has to discover first is a bridged tool it may never use.
			{ alwaysLoad: true },
		);
	});

	return {
		servers: {
			[MCP_SERVER_NAME]: createSdkMcpServer({ name: MCP_SERVER_NAME, tools: sdkTools }),
		},
		toolNames: tools.map((bindable) => bridgedToolName(bindable.name)),
	};
}
