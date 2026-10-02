/**
 * Is this binary a video, from its metadata alone. Decided before any bytes are read, so a
 * recording is never pulled into memory just to learn what it is.
 */

/** We were told nothing useful. */
export const UNINFORMATIVE_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/** Containers n8n or an upstream service may label with an application/* type. */
const VIDEO_APPLICATION_MIME = new Set([
	'application/mp4',
	'application/x-matroska',
	'application/mxf',
]);

/** `.ts` and `.mts` are not here: in `mime.ts` `.ts` is TypeScript, and a guess would be wrong both ways. */
export const VIDEO_EXTENSIONS = [
	'3gp',
	'avi',
	'flv',
	'm2ts',
	'm4v',
	'mkv',
	'mov',
	'mp4',
	'mpeg',
	'mpg',
	'ogv',
	'webm',
	'wmv',
] as const;

const VIDEO_EXTENSION_SET = new Set<string>(VIDEO_EXTENSIONS);

export const normalizeMime = (mime: string | undefined): string =>
	(mime ?? '').toLowerCase().split(';')[0].trim();

export const isVideoMime = (mime: string | undefined): boolean => {
	const m = normalizeMime(mime);
	return m.startsWith('video/') || VIDEO_APPLICATION_MIME.has(m);
};

const extensionOf = (fileName: string | undefined): string =>
	/\.([a-z0-9]{1,5})$/i.exec(fileName ?? '')?.[1].toLowerCase() ?? '';

/** A declared video type, or a video extension on a binary whose type says nothing. */
export const looksLikeVideo = (mime: string | undefined, fileName: string | undefined): boolean =>
	isVideoMime(mime) ||
	(UNINFORMATIVE_MIME.has(normalizeMime(mime)) && VIDEO_EXTENSION_SET.has(extensionOf(fileName)));
