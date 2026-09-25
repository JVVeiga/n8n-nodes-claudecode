import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod/v4';
import { z as z3 } from 'zod/v3';
import { resolveOutputSchema } from '../nodes/ClaudeCodeAgent/outputSchema';

const problemOf = (r: ReturnType<typeof resolveOutputSchema>) => {
	assert.ok(r && 'problem' in r, `expected a Problem, got ${JSON.stringify(r)}`);
	return r.problem;
};

const schemaOf = (r: ReturnType<typeof resolveOutputSchema>) => {
	assert.ok(r && 'schema' in r, `expected a schema, got ${JSON.stringify(r)}`);
	return r.schema;
};

describe('resolveOutputSchema — text', () => {
	it('sends no schema, whatever else is set', () => {
		assert.equal(resolveOutputSchema('text', '{"type":"object"}', { getSchema: () => ({}) }), null);
	});
});

describe('resolveOutputSchema — jsonSchema', () => {
	it('returns a pasted object schema as parsed', () => {
		const schema = {
			type: 'object',
			properties: { summary: { type: 'string' } },
			required: ['summary'],
		};
		assert.deepEqual(
			schemaOf(resolveOutputSchema('jsonSchema', JSON.stringify(schema), undefined)),
			schema,
		);
	});

	it('refuses an empty field', () => {
		const p = problemOf(resolveOutputSchema('jsonSchema', '  ', undefined));
		assert.match(p.message, /empty/);
		assert.match(p.description ?? '', /"type": "object"/);
	});

	it('refuses text that is not JSON, and says why', () => {
		const p = problemOf(resolveOutputSchema('jsonSchema', '{ type: object }', undefined));
		assert.match(p.message, /not valid JSON/);
	});

	it('refuses an array or a scalar', () => {
		assert.match(
			problemOf(resolveOutputSchema('jsonSchema', '[]', undefined)).message,
			/JSON object/,
		);
		assert.match(
			problemOf(resolveOutputSchema('jsonSchema', '7', undefined)).message,
			/JSON object/,
		);
	});

	it('refuses a schema whose top level is not an object, naming the type it has', () => {
		const p = problemOf(resolveOutputSchema('jsonSchema', '{"type":"array"}', undefined));
		assert.match(p.message, /"type": "array"/);
		assert.match(
			problemOf(resolveOutputSchema('jsonSchema', '{"properties":{}}', undefined)).message,
			/no "type"/,
		);
	});
});

describe('resolveOutputSchema — outputParser', () => {
	const parserFor = (schema: unknown) => ({ getSchema: () => schema });

	it("unwraps n8n's { output } wrapper and drops $schema", () => {
		const zodObj = z.object({ output: z.object({ a: z.string(), n: z.number().optional() }) });
		const schema = schemaOf(resolveOutputSchema('outputParser', '', parserFor(zodObj)));
		assert.equal(schema.type, 'object');
		assert.equal('$schema' in schema, false);
		assert.deepEqual(Object.keys(schema.properties as object).sort(), ['a', 'n']);
		assert.deepEqual(schema.required, ['a']);
	});

	it('unwraps a zod v3 schema the same way', () => {
		const zodObj = z3.object({ output: z3.object({ a: z3.string() }) });
		const schema = schemaOf(resolveOutputSchema('outputParser', '', parserFor(zodObj)));
		assert.equal(schema.type, 'object');
		assert.deepEqual(Object.keys(schema.properties as object), ['a']);
	});

	it('returns a schema without the wrapper as it is', () => {
		const zodObj = z.object({ a: z.string(), b: z.string() });
		const schema = schemaOf(resolveOutputSchema('outputParser', '', parserFor(zodObj)));
		assert.deepEqual(Object.keys(schema.properties as object), ['a', 'b']);
	});

	it('keeps the wrapper when the inner schema is not an object', () => {
		const zodObj = z.object({ output: z.array(z.string()) });
		const schema = schemaOf(resolveOutputSchema('outputParser', '', parserFor(zodObj)));
		assert.deepEqual(Object.keys(schema.properties as object), ['output']);
	});

	it('refuses when no parser is connected', () => {
		const p = problemOf(resolveOutputSchema('outputParser', '', undefined));
		assert.match(p.message, /no output parser is connected/);
		assert.match(p.description ?? '', /Structured Output Parser/);
	});

	it('refuses a connected node that has no getSchema', () => {
		const p = problemOf(resolveOutputSchema('outputParser', '', { parse: () => ({}) }));
		assert.match(p.message, /does not provide a schema/);
	});

	it('turns a getSchema that throws into a Problem', () => {
		const p = problemOf(
			resolveOutputSchema('outputParser', '', {
				getSchema: () => {
					throw new Error('bad schema');
				},
			}),
		);
		assert.match(p.message, /bad schema/);
	});

	it('refuses a parser schema that is not an object', () => {
		const p = problemOf(resolveOutputSchema('outputParser', '', parserFor(z.string())));
		assert.match(p.message, /does not describe an object/);
	});
});
