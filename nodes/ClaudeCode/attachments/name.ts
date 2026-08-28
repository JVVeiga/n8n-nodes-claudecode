import { extensionForMime, extensionOf } from './mime';

/**
 * What to call a file.
 *
 * The name matters more than it looks. It is the `title` on a document block, the on-disk name of
 * a staged file, and the string the model uses when the prompt says "the error in screenshot.png" —
 * so it has to be the same string in all three places, has to survive being written to a
 * filesystem, and has to be unique within one item or two attachments collapse onto one path.
 */

/** Anything outside this becomes `_`. Deliberately narrow: the name reaches a shell-adjacent
 * filesystem path, and no legitimate attachment needs more than this. */
const UNSAFE_CHARS = /[^A-Za-z0-9._-]+/g;

/** Two or more dots in a row. A single dot separates a name from its extension; a run of them only
 * ever comes from a traversal attempt, and leaving it in produces names like `.._.._etc_passwd` —
 * safe, but noise in a prompt the model has to read. */
const DOT_RUN = /\.{2,}/g;

/** Guard against a name that is all dots — `.`, `..` and friends are directory entries, not files. */
const ALL_DOTS = /^\.+$/;

/**
 * Make a name safe as a single filesystem component: no directory separators, no shell-special
 * characters, no `..` traversal.
 *
 * Order matters. Dot-runs collapse first, then separators flatten, then everything unsafe becomes
 * `_`, then runs of `_` collapse and the edges are trimmed — so `../../etc/passwd` ends up
 * `etc_passwd` rather than `.._.._etc_passwd`.
 */
export function sanitizeFileName(name: string | undefined, fallback: string): string {
	if (!name) return fallback;
	const cleaned = name
		.replace(DOT_RUN, '_')
		.replace(/[\\/]/g, '_')
		.replace(UNSAFE_CHARS, '_')
		.replace(/_{2,}/g, '_')
		.replace(/^_+|_+$/g, '');
	if (cleaned === '' || ALL_DOTS.test(cleaned)) return fallback;
	return cleaned;
}

/**
 * The derivation ladder, most helpful first:
 *
 *   1. The binary's own `fileName`, if it already carries an extension.
 *   2. That `fileName` plus an extension from `fileExtension` or the MIME table.
 *   3. The property name plus that extension.
 *   4. The property name alone, when nothing implies an extension.
 *   5. `<propName>.bin`.
 *
 * An extension is worth this much trouble because it is how a staged file gets read correctly and
 * how the model recognises what it is looking at.
 */
export function deriveFileName(
	meta: { fileName?: string; fileExtension?: string; mimeType?: string },
	propName: string,
): string {
	const ext = (meta.fileExtension ?? '').replace(/^\./, '') || extensionForMime(meta.mimeType);

	if (meta.fileName) {
		if (extensionOf(meta.fileName) !== '') return meta.fileName;
		return ext ? `${meta.fileName}.${ext}` : meta.fileName;
	}
	return ext ? `${propName}.${ext}` : `${propName}.bin`;
}

/**
 * Make `name` distinct from everything in `used`, inserting the counter before the extension so
 * `a.png` becomes `a-2.png` rather than `a.png-2`. Mutates nothing — the caller records the result.
 */
export function uniquifyFileName(name: string, used: ReadonlySet<string>): string {
	if (!used.has(name)) return name;

	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : '';

	// Bounded rather than unbounded: the caller's set is capped by maxAttachmentCount, so this
	// cannot fail to find a slot, and a bound means no unbounded loop in the run path.
	for (let n = 2; n <= used.size + 2; n++) {
		const candidate = `${stem}-${n}${ext}`;
		if (!used.has(candidate)) return candidate;
	}
	// Unreachable while `used` is finite, but a name is safer than a throw here.
	return `${stem}-${used.size + 3}${ext}`;
}

/**
 * The two steps together, for one attachment: derive, sanitize, uniquify. `used` is the set of
 * names already taken within this item; the caller adds the result to it.
 */
export function resolveFileName(
	meta: { fileName?: string; fileExtension?: string; mimeType?: string },
	propName: string,
	used: ReadonlySet<string>,
): string {
	const derived = deriveFileName(meta, propName);
	const safe = sanitizeFileName(derived, `${sanitizeFileName(propName, 'attachment')}.bin`);
	return uniquifyFileName(safe, used);
}
