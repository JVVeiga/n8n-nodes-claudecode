import { toJsonSchema } from '@langchain/core/utils/json_schema';
import type { Problem } from '../shared/problem';
import { isRecord } from './values';

export type OutputMode = 'text' | 'jsonSchema' | 'outputParser';

export type ResolvedSchema = { schema: Record<string, unknown> } | null | { problem: Problem };

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const OBJECT_SCHEMA_FIX =
	'Structured output needs a JSON Schema whose top level is an object, for example ' +
	'{ "type": "object", "properties": { "summary": { "type": "string" } }, "required": ["summary"] }.';

function fromPastedText(text: string): ResolvedSchema {
	if (text.trim() === '') {
		return {
			problem: {
				message: 'Output Mode is JSON Schema but the JSON Schema field is empty.',
				description: OBJECT_SCHEMA_FIX,
			},
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			problem: {
				message: `The JSON Schema is not valid JSON: ${errorText(error)}`,
				description: OBJECT_SCHEMA_FIX,
			},
		};
	}
	if (!isRecord(parsed)) {
		return {
			problem: {
				message: 'The JSON Schema must be a JSON object, not an array or a single value.',
				description: OBJECT_SCHEMA_FIX,
			},
		};
	}
	if (parsed.type !== 'object') {
		const got = parsed.type === undefined ? 'no "type"' : `"type": ${JSON.stringify(parsed.type)}`;
		return {
			problem: {
				message: `The JSON Schema must describe an object ("type": "object"), but it has ${got}.`,
				description: OBJECT_SCHEMA_FIX,
			},
		};
	}
	return { schema: parsed };
}

const NO_PARSER_FIX =
	'Connect a Structured Output Parser to the Output Parser input, or change Output Mode.';

/**
 * n8n's parser wraps the user's schema as `{ output: <schema> }`. The inner one is sent, so
 * `structured` holds the user's own object in both schema modes. An inner schema that is not an
 * object is sent wrapped: the model delivers structured output as a tool call, and a tool's input
 * must be an object.
 */
function unwrap(schema: Record<string, unknown>): Record<string, unknown> {
	const properties = schema.properties;
	if (!isRecord(properties)) return schema;
	const keys = Object.keys(properties);
	if (keys.length !== 1 || keys[0] !== 'output') return schema;
	const inner = properties.output;
	if (!isRecord(inner) || inner.type !== 'object') return schema;
	const copy = { ...inner };
	delete copy.$schema;
	return copy;
}

function fromParser(parser: unknown): ResolvedSchema {
	if (parser === undefined || parser === null) {
		return {
			problem: {
				message: 'Output Mode is Output Parser but no output parser is connected.',
				description: NO_PARSER_FIX,
			},
		};
	}
	const getSchema = isRecord(parser) ? parser.getSchema : undefined;
	if (typeof getSchema !== 'function') {
		return {
			problem: {
				message: 'The node connected to the Output Parser input does not provide a schema.',
				description: NO_PARSER_FIX,
			},
		};
	}
	let converted: unknown;
	try {
		converted = toJsonSchema((getSchema as () => never).call(parser), {
			unrepresentable: 'any',
		});
	} catch (error) {
		return {
			problem: {
				message: `The output parser's schema could not be converted to JSON Schema: ${errorText(error)}`,
				description:
					'Simplify the parser schema, or paste a JSON Schema with Output Mode JSON Schema.',
			},
		};
	}
	if (!isRecord(converted) || converted.type !== 'object') {
		return {
			problem: {
				message: "The output parser's schema does not describe an object.",
				description: OBJECT_SCHEMA_FIX,
			},
		};
	}
	return { schema: unwrap(converted) };
}

export function resolveOutputSchema(
	mode: OutputMode,
	pastedSchemaText: string,
	parser: unknown,
): ResolvedSchema {
	if (mode === 'jsonSchema') return fromPastedText(pastedSchemaText);
	if (mode === 'outputParser') return fromParser(parser);
	return null;
}
