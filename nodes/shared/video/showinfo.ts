/**
 * `showinfo` lines -> each frame's real time. Every reported time comes from here: times computed
 * from the request drifted 2–14 s from the content.
 */

export type ShownFrame = { n: number; ptsTime: number };

const LINE =
	/\[Parsed_showinfo_\d+ @ [^\]]+\] n:\s*(\d+) pts:\s*-?\d+ pts_time:(-?[\d.]+(?:e[-+]?\d+)?)/;

export function parseShowinfo(stderr: string): ShownFrame[] {
	const frames: ShownFrame[] = [];
	for (const line of stderr.split('\n')) {
		const match = LINE.exec(line);
		if (match) frames.push({ n: Number(match[1]), ptsTime: Number(match[2]) });
	}
	return frames;
}
