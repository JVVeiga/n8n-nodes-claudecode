import type { AttachmentSpec, InlineImageMediaType, Route } from './types';

/**
 * The whole routing policy, as data plus one pure function.
 *
 * Everything about "which files reach the model directly and which get written to disk" is decided
 * here, from a MIME type and a byte count. No buffer source, no filesystem, no node parameters
 * beyond the spec — which is why the policy is assertable on its own, and why adding a file type
 * is an entry in a table rather than a branch somewhere in the run path.
 */

/**
 * The only four values `Base64ImageSource.media_type` accepts
 * (`@anthropic-ai/sdk/resources/messages/messages.d.ts`). This is an allowlist, not a preference:
 * an image block with any other media type is a 400 from the API, not a degraded result. In
 * particular `image/svg+xml` is NOT here — it is XML, and it routes as text.
 */
const IMAGE_MEDIA_TYPES: Record<string, InlineImageMediaType> = {
	'image/png': 'image/png',
	'image/jpeg': 'image/jpeg',
	'image/jpg': 'image/jpeg',
	'image/gif': 'image/gif',
	'image/webp': 'image/webp',
};

/**
 * Textual `application/*` and `image/*` types, which `text/*` prefix matching cannot catch. A
 * `PlainTextSource` document block takes any of these verbatim — the API does not parse them, the
 * model reads them.
 */
const TEXTUAL_MIME = new Set([
	'application/json',
	'application/xml',
	'application/xhtml+xml',
	'application/x-yaml',
	'application/yaml',
	'application/javascript',
	'application/x-javascript',
	'application/typescript',
	'application/sql',
	'application/x-sh',
	'application/graphql',
	'application/x-ndjson',
	// XML with an image MIME type. Sent as an image block it would be rejected outright.
	'image/svg+xml',
]);

/**
 * Extension -> MIME, for the case n8n reports no MIME type or reports
 * `application/octet-stream` — which the HTTP Request node does routinely. Only types that change
 * a routing decision are listed; anything absent falls through to the byte sniff.
 */
const EXT_TO_MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	pdf: 'application/pdf',
	txt: 'text/plain',
	log: 'text/plain',
	md: 'text/markdown',
	markdown: 'text/markdown',
	csv: 'text/csv',
	tsv: 'text/tab-separated-values',
	html: 'text/html',
	htm: 'text/html',
	xml: 'application/xml',
	json: 'application/json',
	ndjson: 'application/x-ndjson',
	yaml: 'application/x-yaml',
	yml: 'application/x-yaml',
	sql: 'application/sql',
	js: 'application/javascript',
	mjs: 'application/javascript',
	ts: 'application/typescript',
	sh: 'application/x-sh',
	graphql: 'application/graphql',
};

/** MIME -> extension, for naming a file whose own name carries none. See `name.ts`. */
const MIME_TO_EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/svg+xml': 'svg',
	'image/heic': 'heic',
	'image/bmp': 'bmp',
	'image/tiff': 'tiff',
	'application/pdf': 'pdf',
	'text/plain': 'txt',
	'text/markdown': 'md',
	'text/csv': 'csv',
	'text/tab-separated-values': 'tsv',
	'text/html': 'html',
	'application/xml': 'xml',
	'text/xml': 'xml',
	'application/json': 'json',
	'application/x-ndjson': 'ndjson',
	'application/x-yaml': 'yaml',
	'application/yaml': 'yaml',
	'application/javascript': 'js',
	'application/typescript': 'ts',
	'application/sql': 'sql',
	'application/x-sh': 'sh',
	'application/graphql': 'graphql',
	'application/zip': 'zip',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
	'application/vnd.ms-excel': 'xls',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/**
 * API ceilings, not user knobs. Exposing them as parameters would only let a user configure a 400,
 * so they are constants and a file over one of them stages instead.
 */
const IMAGE_INLINE_MAX_BYTES = 5 * 1024 * 1024;
const PDF_INLINE_MAX_BYTES = 20 * 1024 * 1024;

/** How much of a buffer the text sniff inspects. Enough to catch a binary header without reading
 * a 40 MB file to decide how to route it. */
const SNIFF_BYTES = 64 * 1024;

/** MIME types that mean "we were told nothing useful" and require the extension/byte fallback. */
const UNINFORMATIVE_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/** Strip parameters and case from a MIME type: `Text/CSV; charset=utf-8` -> `text/csv`. */
export const normalizeMime = (mimeType: string | undefined): string =>
	(mimeType ?? '').toLowerCase().split(';')[0].trim();

/** Best-effort extension for a MIME type. Empty string when unknown. */
export const extensionForMime = (mimeType: string | undefined): string =>
	MIME_TO_EXT[normalizeMime(mimeType)] ?? '';

/** The extension of a filename, lowercased and without the dot. Empty when it has none. */
export function extensionOf(fileName: string): string {
	const dot = fileName.lastIndexOf('.');
	if (dot <= 0 || dot === fileName.length - 1) return '';
	return fileName.slice(dot + 1).toLowerCase();
}

/**
 * Whether a buffer is text. Valid UTF-8 with no NUL byte — the NUL check is what separates a UTF-8
 * text file from a binary that happens to decode without replacement characters.
 *
 * Only the first `SNIFF_BYTES` are inspected, so a truncated multi-byte sequence at the boundary
 * would be a false negative; the slice is taken back to a safe boundary by trimming any trailing
 * bytes that could begin a multi-byte sequence.
 */
export function sniffText(buffer: Buffer): boolean {
	let end = Math.min(buffer.length, SNIFF_BYTES);
	// When the slice is a prefix, walk back off a multi-byte sequence the cut would have split —
	// at most three continuation bytes. Without this, a UTF-8 file whose 65536th byte lands
	// mid-character would sniff as binary.
	for (let i = 0; end > 0 && end < buffer.length && i < 3; i++) {
		if ((buffer[end] & 0xc0) !== 0x80) break;
		end -= 1;
	}

	const slice = buffer.subarray(0, end);
	// A NUL byte is what separates a text file from a binary that happens to decode cleanly.
	if (slice.includes(0)) return false;
	// Valid UTF-8 round-trips byte-identically. Invalid bytes decode to U+FFFD, which re-encodes
	// to three different bytes, so the comparison catches them exactly — no scanning for the
	// replacement character, which a legitimate text file may itself contain.
	return Buffer.from(slice.toString('utf8'), 'utf8').equals(slice);
}

/**
 * The MIME type to route by: what n8n said, or — when that was nothing useful — what the
 * extension implies, or what the bytes look like.
 *
 * Exported because the debug log and diagnostics report the type actually used, not the one n8n
 * claimed; "why did my .csv stage" is unanswerable otherwise.
 */
export function effectiveMime(
	mimeType: string | undefined,
	fileName: string,
	buffer: Buffer,
): string {
	const declared = normalizeMime(mimeType);
	if (!UNINFORMATIVE_MIME.has(declared)) return declared;

	const fromExt = EXT_TO_MIME[extensionOf(fileName)];
	if (fromExt) return fromExt;

	return sniffText(buffer) ? 'text/plain' : declared || 'application/octet-stream';
}

/** Whether a resolved MIME type can be sent as a `PlainTextSource` document block. */
export const isTextualMime = (mime: string): boolean =>
	mime.startsWith('text/') || TEXTUAL_MIME.has(mime);

/**
 * How this file reaches the model. Total: every input returns a Route, and `staged` always says
 * why, because that reason is the whole content of the answer to "where did my file go".
 */
export function routeFor(mime: string, bytes: number, spec: AttachmentSpec): Route {
	const imageMediaType = IMAGE_MEDIA_TYPES[mime];
	if (imageMediaType) {
		return bytes <= IMAGE_INLINE_MAX_BYTES
			? { kind: 'image', mediaType: imageMediaType }
			: { kind: 'staged', reason: 'over-inline-limit' };
	}

	if (mime === 'application/pdf') {
		return bytes <= PDF_INLINE_MAX_BYTES
			? { kind: 'document-pdf' }
			: { kind: 'staged', reason: 'over-inline-limit' };
	}

	if (isTextualMime(mime)) {
		return bytes <= spec.inlineTextLimitKb * 1024
			? { kind: 'document-text' }
			: { kind: 'staged', reason: 'over-inline-limit' };
	}

	return { kind: 'staged', reason: 'no-inline-route' };
}

/**
 * Every extension either table understands — what `EXT_TO_MIME` can resolve plus what
 * `MIME_TO_EXT` can name.
 *
 * Exported so the Allowed Extensions option list can be checked against it: if the router can name
 * a type, the filter has to be able to select it, or a user gets handed a file they have no way to
 * filter on and the only escape is turning the filter off entirely. A test asserts the containment.
 */
export const ROUTABLE_EXTENSIONS: string[] = [
	...new Set([...Object.keys(EXT_TO_MIME), ...Object.values(MIME_TO_EXT)]),
].sort();

/** The ceilings, exported so a test pins them rather than restating the numbers. */
export const INLINE_CEILINGS = {
	imageBytes: IMAGE_INLINE_MAX_BYTES,
	pdfBytes: PDF_INLINE_MAX_BYTES,
} as const;
