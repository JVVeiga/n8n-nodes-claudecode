import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FfmpegSource } from './types';
import { isUsableFontPath } from './args';

/**
 * Which ffmpeg, and which font for the labels. ffmpeg is not bundled: n8n's community installer
 * strips `optionalDependencies` before `npm install`, so a platform binary declared there never
 * arrives. It has to be on the server.
 */

export type FfmpegCandidate = { path: string; source: FfmpegSource };

export type BinaryDeps = {
	env: NodeJS.ProcessEnv;
	exists: (path: string) => boolean;
	listDir: (path: string) => string[];
};

const defaultDeps: BinaryDeps = {
	env: process.env,
	exists: existsSync,
	listDir: (path) => readdirSync(path),
};

/**
 * A configured path, then FFMPEG_PATH, then `ffmpeg` on the PATH. An explicit choice is the only
 * candidate, so a typo fails instead of silently running another binary.
 */
export function ffmpegCandidates(
	configured: string,
	deps: BinaryDeps = defaultDeps,
): { candidates: FfmpegCandidate[]; notes: string[] } {
	if (configured.trim()) {
		return { candidates: [{ path: configured.trim(), source: 'configured' }], notes: [] };
	}
	const fromEnv = (deps.env.FFMPEG_PATH ?? '').trim();
	if (fromEnv) return { candidates: [{ path: fromEnv, source: 'env' }], notes: [] };
	return { candidates: [{ path: 'ffmpeg', source: 'path' }], notes: [] };
}

const FONT_CANDIDATES = [
	// n8n's image
	'/usr/share/fonts/truetype/msttcorefonts/Arial.ttf',
	'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
	'/usr/share/fonts/dejavu/DejaVuSans.ttf',
	'/usr/share/fonts/TTF/DejaVuSans.ttf',
	'/usr/share/fonts/noto/NotoSans-Regular.ttf',
	'/System/Library/Fonts/Supplemental/Arial.ttf',
	'/Library/Fonts/Arial.ttf',
];

const FONT_ROOTS = ['/usr/share/fonts', '/usr/local/share/fonts'];

function firstTtfUnder(root: string, deps: BinaryDeps, depth = 3): string | null {
	if (depth < 0 || !deps.exists(root)) return null;
	let entries: string[];
	try {
		entries = deps.listDir(root).sort();
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (/\.ttf$/i.test(entry)) return join(root, entry);
	}
	for (const entry of entries) {
		if (/\.\w+$/.test(entry)) continue;
		const found = firstTtfUnder(join(root, entry), deps, depth - 1);
		if (found) return found;
	}
	return null;
}

/** A TrueType font drawtext can open, or null: the labels are then left out and reported. */
export function findFont(deps: BinaryDeps = defaultDeps): string | null {
	for (const path of FONT_CANDIDATES) {
		if (deps.exists(path) && isUsableFontPath(path)) return path;
	}
	for (const root of FONT_ROOTS) {
		const found = firstTtfUnder(root, deps);
		if (found && isUsableFontPath(found)) return found;
	}
	return null;
}
