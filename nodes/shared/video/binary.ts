import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FfmpegSource } from './types';
import { isUsableFontPath } from './args';

/**
 * Which ffmpeg, and which font for the labels. `@ffmpeg-installer` ships the binary inside the
 * tarball, so it survives n8n installing community packages with `--ignore-scripts`.
 */

export type FfmpegCandidate = { path: string; source: FfmpegSource };

export type BinaryDeps = {
	requireBundled: () => { path: string };
	exists: (path: string) => boolean;
	listDir: (path: string) => string[];
};

const defaultDeps: BinaryDeps = {
	requireBundled: () => require('@ffmpeg-installer/ffmpeg') as { path: string },
	exists: existsSync,
	listDir: (path) => readdirSync(path),
};

/** A configured path is the only candidate, so a typo fails instead of running another binary. */
export function ffmpegCandidates(
	configured: string,
	deps: BinaryDeps = defaultDeps,
): { candidates: FfmpegCandidate[]; notes: string[] } {
	if (configured.trim()) {
		return { candidates: [{ path: configured.trim(), source: 'configured' }], notes: [] };
	}
	const candidates: FfmpegCandidate[] = [];
	const notes: string[] = [];
	try {
		candidates.push({ path: deps.requireBundled().path, source: 'bundled' });
	} catch (error) {
		// No prebuilt package for this platform: @ffmpeg-installer throws from its index.
		notes.push(`bundled: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
	}
	candidates.push({ path: 'ffmpeg', source: 'path' });
	return { candidates, notes };
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
