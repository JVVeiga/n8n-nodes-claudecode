import { statSync } from 'fs';
import type { Problem } from './problem';

/**
 * Both nodes accept a Project Path and both have to validate it before spawning. They carried
 * byte-identical copies of this check, its message and its description.
 *
 * The validation is not optional politeness: the SDK's spawn-error handler blames a
 * libc/architecture mismatch for the ENOENT that a missing cwd produces, which sends users
 * chasing a phantom problem instead of a typo.
 */

export const PROJECT_PATH_DESCRIPTION =
	'The path must exist inside the n8n container. If n8n runs in Docker, make sure the directory is mounted into it.';

export const isDirectory = (path: string): boolean => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

/**
 * Returns null when the path is usable — which includes an empty path, meaning "leave cwd alone".
 * `exists` is injectable so callers can be tested without touching a filesystem.
 */
export function checkProjectPath(
	path: string,
	exists: (p: string) => boolean = isDirectory,
): Problem | null {
	const trimmed = path.trim();
	if (trimmed === '') return null;
	if (exists(trimmed)) return null;
	return {
		message: `Project Path is not an existing directory: ${trimmed}`,
		description: PROJECT_PATH_DESCRIPTION,
	};
}
