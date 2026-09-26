import { execFile } from 'node:child_process';
import type { Problem } from '../shared/problem';
import { checkRef } from './refs';

/** `missing` marks a path absent at the ref — a per-item fact, not a broken repository. */
export type GitResult = { ok: string } | { problem: Problem; missing?: true };

export type GitApi = {
	mergeBase(base: string, head: string): Promise<GitResult>;
	numstat(from: string, to: string): Promise<GitResult>;
	patchU0(from: string, to: string): Promise<GitResult>;
	showFile(ref: string, path: string): Promise<GitResult>;
};

export type ExecOptions = {
	cwd: string;
	timeout: number;
	maxBuffer: number;
	env: NodeJS.ProcessEnv;
};

export type ExecFailure = Error & {
	code?: string | number;
	killed?: boolean;
	signal?: string | null;
	stderr?: string;
};

export type ExecFileFn = (
	file: string,
	args: string[],
	options: ExecOptions,
) => Promise<{ stdout: string }>;

export const GIT_TIMEOUT_MS = 60_000;
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_BUFFER_MB = GIT_MAX_BUFFER / (1024 * 1024);

const isOverflow = (error: ExecFailure): boolean =>
	error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

// quotePath off: a non-ASCII name comes back as UTF-8, not octal escapes. Literal pathspecs: a
// file named `*.ts` is that file, not a glob.
const GLOBAL_ARGS = ['-c', 'core.quotePath=false', '--literal-pathspecs'];

// Explicit prefixes and flags override user config (diff.noprefix, diff.relative, external
// diff drivers) that would otherwise change what the parsers see.
const DIFF_ARGS = [
	'--no-color',
	'--no-ext-diff',
	'--no-textconv',
	'--find-renames',
	'--no-relative',
];

const execFileAsync: ExecFileFn = (file, args, options) =>
	new Promise((resolve, reject) => {
		execFile(
			file,
			args,
			{ ...options, encoding: 'utf8', windowsHide: true },
			(error, stdout, stderr) => {
				if (error) {
					reject(Object.assign(error, { stderr }));
					return;
				}
				resolve({ stdout });
			},
		);
	});

function describeFailure(error: ExecFailure, stderr: string): string {
	if (error.code === 'ENOENT') {
		return 'git is not installed, or not on the PATH of the n8n process. Install git in the n8n container.';
	}
	if (error.killed || error.signal) {
		return `git did not finish within ${GIT_TIMEOUT_MS / 1000}s. A very large diff or a slow disk is the usual cause.`;
	}
	if (/not a git repository/i.test(stderr)) {
		return 'Project Path must be a directory inside a git repository (a clone, with its .git).';
	}
	if (/dubious ownership/i.test(stderr)) {
		return "git refuses a repository owned by another user. Make the n8n user own the clone, or add it to safe.directory in that user's git config.";
	}
	if (/unknown revision|not a valid object name|bad revision|invalid object name/i.test(stderr)) {
		return 'The ref does not exist in this clone. Fetch it first — a shallow CI clone often lacks the base branch.';
	}
	return 'See the git error above.';
}

function toProblem(args: string[], error: unknown): Problem {
	const failure = error as ExecFailure;
	// Checked first: node kills the child on overflow, which would otherwise read as a timeout.
	if (isOverflow(failure)) {
		return {
			message: `git ${args[0]} output is larger than ${MAX_BUFFER_MB} MB`,
			description:
				'The change between these refs is too large to read. Narrow it: a Base Ref closer to ' +
				'Head Ref, or smaller changes per review.',
		};
	}
	const stderr = (failure.stderr ?? '').trim();
	const detail = stderr.split('\n')[0] || failure.message;
	return {
		message: `git ${args[0]} failed: ${detail}`,
		description: describeFailure(failure, stderr),
	};
}

/** The only module that spawns anything: git, with an argument array and never a shell. */
export function createGit(projectPath: string, execFileImpl: ExecFileFn = execFileAsync): GitApi {
	const options: ExecOptions = {
		cwd: projectPath,
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: GIT_MAX_BUFFER,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
	};

	const run = async (args: string[], onFailure?: (e: ExecFailure) => Problem | null) => {
		try {
			const { stdout } = await execFileImpl('git', [...GLOBAL_ARGS, ...args], options);
			return { ok: stdout } as GitResult;
		} catch (error) {
			return { problem: onFailure?.(error as ExecFailure) ?? toProblem(args, error) } as GitResult;
		}
	};

	const refs = (...pairs: Array<[string, string]>): GitResult | null => {
		for (const [ref, label] of pairs) {
			const problem = checkRef(ref, label);
			if (problem) return { problem };
		}
		return null;
	};

	return {
		async mergeBase(base, head) {
			const bad = refs([base, 'Base Ref'], [head, 'Head Ref']);
			if (bad) return bad;
			// Exit 1 with nothing on stderr is merge-base's way of saying "no common ancestor".
			const result = await run(['merge-base', base, head], (e) =>
				e.code === 1 && !(e.stderr ?? '').trim()
					? {
							message: `${base} and ${head} have no common ancestor`,
							description:
								'The two refs share no history. Check Base Ref, or fetch more history in a shallow clone.',
						}
					: null,
			);
			return 'ok' in result ? { ok: result.ok.trim() } : result;
		},

		async numstat(from, to) {
			const bad = refs([from, 'From ref'], [to, 'To ref']);
			if (bad) return bad;
			return run(['diff', '--raw', '--numstat', '-z', ...DIFF_ARGS, from, to, '--']);
		},

		async patchU0(from, to) {
			const bad = refs([from, 'From ref'], [to, 'To ref']);
			if (bad) return bad;
			return run([
				'diff',
				'-U0',
				...DIFF_ARGS,
				'--src-prefix=a/',
				'--dst-prefix=b/',
				from,
				to,
				'--',
			]);
		},

		async showFile(ref, path) {
			const bad = refs([ref, 'Ref']);
			if (bad) return bad;
			if (path === '' || path.includes('\0')) {
				return {
					problem: { message: `not a usable path: ${JSON.stringify(path)}` },
					missing: true,
				};
			}
			// ls-tree takes the path after `--`, so no path can be read as an option or a revision.
			const listed = await run(['ls-tree', '-z', '--full-tree', ref, '--', path]);
			if ('problem' in listed) return listed;
			const entry = listed.ok.split('\0')[0] ?? '';
			const match = /^\d+ (\w+) ([0-9a-f]{40,64})\t/.exec(entry);
			if (!match) {
				return { problem: { message: `${path} does not exist at ${ref}` }, missing: true };
			}
			if (match[1] !== 'blob') {
				return { problem: { message: `${path} is not a file at ${ref}` }, missing: true };
			}
			// One oversized file is that item's problem, not the whole run's.
			let tooLarge = false;
			const blob = await run(['cat-file', 'blob', match[2]], (e) => {
				tooLarge = isOverflow(e);
				return tooLarge
					? { message: `${path} is larger than ${MAX_BUFFER_MB} MB at ${ref}` }
					: null;
			});
			return tooLarge ? { ...blob, missing: true } : blob;
		},
	};
}
