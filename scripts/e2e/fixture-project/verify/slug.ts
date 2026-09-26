export const MAX_SLUG_LENGTH = 64;

/**
 * Turns a title into a URL slug: "Hello, World!" becomes "hello-world".
 */
export function toSlug(title: string): string {
	if (typeof title !== 'string' || title.trim() === '') {
		throw new Error('toSlug: title must be a non-empty string');
	}
	return title
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_SLUG_LENGTH);
}
