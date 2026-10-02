/**
 * An exported SRT, made fit to read. ffmpeg wraps mov_text cues in `<font>` tags and keeps ASS
 * override blocks like `{\an8}`; neither tells the model anything.
 */
export function cleanSrt(srt: string): { text: string; cues: number } {
	const text = srt
		.replace(/\r\n/g, '\n')
		.replace(/<[^>\n]+>/g, '')
		.replace(/\{\\[^}\n]*\}/g, '')
		.trim();
	const cues = (text.match(/^\d{2}:\d{2}:\d{2},\d{3} --> /gm) ?? []).length;
	return { text: text ? `${text}\n` : '', cues };
}
