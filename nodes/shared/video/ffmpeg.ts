import { execFile } from 'node:child_process';

/**
 * The only module that spawns ffmpeg: `execFile`, never a shell. It never throws: the exit code is
 * data, because the probe exits 1 when it succeeds.
 */

export type FfmpegRun = {
	code: number | null;
	stdout: string;
	stderr: string;
	/** Killed by the timeout or the abort signal. */
	killed: boolean;
	/** `ENOENT` when the binary is not there, `EACCES` when it cannot be executed. */
	spawnError?: string;
};

export type RunOptions = { timeoutMs: number; signal?: AbortSignal };

export type FfmpegRunner = (
	binary: string,
	args: string[],
	options: RunOptions,
) => Promise<FfmpegRun>;

/** showinfo prints one line per decoded keyframe; hours of video stay far below this. */
export const FFMPEG_MAX_BUFFER = 64 * 1024 * 1024;

export const runFfmpeg: FfmpegRunner = (binary, args, { timeoutMs, signal }) =>
	new Promise((resolve) => {
		execFile(
			binary,
			args,
			{
				encoding: 'utf8',
				maxBuffer: FFMPEG_MAX_BUFFER,
				timeout: Math.max(1, timeoutMs),
				killSignal: 'SIGKILL',
				windowsHide: true,
				signal,
			},
			(error, stdout, stderr) => {
				const failure = error as
					| (Error & { code?: string | number; killed?: boolean; signal?: string | null })
					| null;
				resolve({
					code: failure ? (typeof failure.code === 'number' ? failure.code : null) : 0,
					stdout: stdout ?? '',
					stderr: stderr ?? '',
					killed: Boolean(failure?.killed || failure?.signal || failure?.name === 'AbortError'),
					...(typeof failure?.code === 'string' ? { spawnError: failure.code } : {}),
				});
			},
		);
	});
