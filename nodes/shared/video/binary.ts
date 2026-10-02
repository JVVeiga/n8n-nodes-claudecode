import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FfmpegSource } from './types';
import { isUsableFontPath } from './args';

/**
 * Which ffmpeg, and which font for the labels. `@ffmpeg-installer/linux-*` ship the binary inside
 * the tarball, so it survives n8n installing community packages with `--ignore-scripts`. Only the
 * Linux builds are bundled: both are GPLv3, while the darwin-arm64 build is configured
 * `--enable-nonfree` and declares itself not redistributable.
 */

export type FfmpegCandidate = { path: string; source: FfmpegSource };

export type BinaryDeps = {
	platform: string;
	arch: string;
	/** Resolves a package's package.json, or throws when it is not installed. */
	resolve: (id: string) => string;
	exists: (path: string) => boolean;
	listDir: (path: string) => string[];
};

const defaultDeps: BinaryDeps = {
	platform: process.platform,
	arch: process.arch,
	resolve: (id) => require.resolve(id),
	exists: existsSync,
	listDir: (path) => readdirSync(path),
};

const BUNDLED: Record<string, string> = {
	'linux-x64': '@ffmpeg-installer/linux-x64',
	'linux-arm64': '@ffmpeg-installer/linux-arm64',
};

function bundledFfmpeg(deps: BinaryDeps): { path: string } | { note: string } {
	const key = `${deps.platform}-${deps.arch}`;
	const pkg = BUNDLED[key];
	if (!pkg) {
		return {
			note: `bundled: none for ${key} (only linux-x64 and linux-arm64 are bundled; install ffmpeg on the PATH)`,
		};
	}
	try {
		return { path: join(dirname(deps.resolve(`${pkg}/package.json`)), 'ffmpeg') };
	} catch {
		return { note: `bundled: ${pkg} is not installed` };
	}
}

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
	const bundled = bundledFfmpeg(deps);
	if ('path' in bundled) candidates.push({ path: bundled.path, source: 'bundled' });
	else notes.push(bundled.note);
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
