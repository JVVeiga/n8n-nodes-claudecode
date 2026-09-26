/**
 * Parsers for the exact output `git.ts` asks git for:
 *
 * - `git diff --raw --numstat -z --find-renames` — raw records (status) followed by numstat records
 *   (counts), NUL-separated so no path is ever quoted.
 * - `git diff -U0 --src-prefix=a/ --dst-prefix=b/` with `core.quotePath=false` — only paths with a
 *   `"`, a backslash or a control character come back C-quoted.
 */

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export type DiffFile = {
	path: string;
	oldPath?: string;
	status: FileStatus;
	/** Null for a binary file, which numstat reports as `-`. */
	additions: number | null;
	deletions: number | null;
};

export type AddedLines = Record<string, number[]>;

const STATUS_BY_LETTER: Record<string, FileStatus> = {
	A: 'added',
	C: 'added',
	D: 'deleted',
	R: 'renamed',
};

const count = (raw: string): number | null => (raw === '-' ? null : Number(raw));

export function parseNumstat(text: string): DiffFile[] {
	const tokens = text.split('\0');
	const statuses: Array<{ status: FileStatus; path: string; oldPath?: string }> = [];
	const counts: Array<{ additions: number | null; deletions: number | null; path: string }> = [];

	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token === '') {
			i++;
			continue;
		}
		if (token.startsWith(':')) {
			const letter = token.trim().split(/\s+/).pop()?.charAt(0) ?? 'M';
			const status = STATUS_BY_LETTER[letter] ?? 'modified';
			if (letter === 'R' || letter === 'C') {
				statuses.push({ status, oldPath: tokens[i + 1], path: tokens[i + 2] });
				i += 3;
			} else {
				statuses.push({ status, path: tokens[i + 1] });
				i += 2;
			}
			continue;
		}
		const [added = '', deleted = '', ...rest] = token.split('\t');
		const inlinePath = rest.join('\t');
		if (inlinePath === '') {
			// A rename: the counts token ends in a tab and the two paths follow.
			counts.push({ additions: count(added), deletions: count(deleted), path: tokens[i + 2] });
			i += 3;
		} else {
			counts.push({ additions: count(added), deletions: count(deleted), path: inlinePath });
			i += 1;
		}
	}

	if (statuses.length === 0) {
		return counts.map((c) => ({ ...c, status: 'modified' as const }));
	}
	return statuses.map((s, index) => {
		const c = counts[index] ?? { additions: null, deletions: null };
		return {
			path: s.path,
			...(s.oldPath !== undefined ? { oldPath: s.oldPath } : {}),
			status: s.status,
			additions: c.additions,
			deletions: c.deletions,
		};
	});
}

const ESCAPES: Record<string, number> = {
	a: 7,
	b: 8,
	t: 9,
	n: 10,
	v: 11,
	f: 12,
	r: 13,
	'"': 34,
	'\\': 92,
};

/** Undo git's C-style quoting (`"b/we\"ird\tname"`); octal escapes are UTF-8 bytes. */
export function unquoteGitPath(raw: string): string {
	if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
	const inner = raw.slice(1, -1);
	const bytes: number[] = [];
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (ch !== '\\') {
			bytes.push(...Buffer.from(ch, 'utf8'));
			continue;
		}
		const next = inner[i + 1];
		if (next === undefined) {
			bytes.push(92);
		} else if (/[0-7]/.test(next)) {
			bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
			i += 3;
		} else {
			bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
			i += 1;
		}
	}
	return Buffer.from(bytes).toString('utf8');
}

/** `+++ b/path`, `+++ "b/path"` or `+++ /dev/null`; git appends a tab after a name with a space. */
function newSidePath(line: string): string | null {
	const raw = line.slice(4).replace(/\t$/, '');
	if (raw === '/dev/null') return null;
	const path = unquoteGitPath(raw);
	return path.startsWith('b/') ? path.slice(2) : path;
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The new-side line number of every `+` line — the lines a review comment can anchor to on the
 * RIGHT side. Every file with a `+++ b/` header gets an entry, even when it added nothing.
 */
export function parseAddedLines(patch: string): AddedLines {
	const result: AddedLines = {};
	let current: number[] | null = null;
	let cursor = 0;
	let oldLeft = 0;
	let newLeft = 0;

	for (const line of patch.split('\n')) {
		if (oldLeft > 0 || newLeft > 0) {
			// Inside a hunk the counts decide, so an added line that reads `+++ x` stays content.
			if (line.startsWith('+')) {
				current?.push(cursor);
				cursor++;
				newLeft--;
				continue;
			}
			if (line.startsWith('-')) {
				oldLeft--;
				continue;
			}
			if (line.startsWith(' ')) {
				cursor++;
				newLeft--;
				oldLeft--;
				continue;
			}
			if (line.startsWith('\\')) continue;
			oldLeft = 0;
			newLeft = 0;
		}

		if (line.startsWith('diff --git ')) {
			current = null;
			continue;
		}
		if (line.startsWith('+++ ')) {
			const path = newSidePath(line);
			current = path === null ? null : (result[path] ??= []);
			continue;
		}
		const hunk = HUNK.exec(line);
		if (hunk) {
			oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
			cursor = Number(hunk[2]);
			newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
		}
	}
	return result;
}

/**
 * Every file still present on the new side gets an entry, so a pure rename or a binary change —
 * which have no `+++` header — read as "in the diff, no added lines" rather than "not in the diff".
 */
export function completeAddedLines(files: DiffFile[], parsed: AddedLines): AddedLines {
	const result: AddedLines = {};
	for (const file of files) {
		if (file.status === 'deleted') continue;
		result[file.path] = parsed[file.path] ?? [];
	}
	for (const [path, lines] of Object.entries(parsed)) {
		if (!(path in result)) result[path] = lines;
	}
	return result;
}

export type TruncatedPatch = { text: string; truncated: boolean };

/** Cuts at the last line break before the cap and says how much was left out. Zero means no cap. */
export function truncatePatch(text: string, maxChars: number): TruncatedPatch {
	if (maxChars <= 0 || text.length <= maxChars) return { text, truncated: false };
	const cut = text.lastIndexOf('\n', maxChars);
	const kept = text.slice(0, cut > 0 ? cut + 1 : maxChars);
	return {
		text: `${kept}[patch truncated: ${kept.length} of ${text.length} characters]\n`,
		truncated: true,
	};
}
