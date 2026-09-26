/**
 * A text parameter's value as text. n8n coerces a parameter only when it declares `validateType`,
 * so an expression such as `{{ $json.ticketId }}` can arrive as a number, null or an array.
 */
export const text = (value: unknown): string =>
	typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
