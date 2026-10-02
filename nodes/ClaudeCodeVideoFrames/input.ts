import { join } from 'node:path';
import type { IBinaryData, IExecuteFunctions } from 'n8n-workflow';
import type { Problem } from '../shared/problem';
import { binarySize, writeBinaryFile } from '../shared/video/binaryFile';
import { isVideoMime, normalizeMime, UNINFORMATIVE_MIME } from '../shared/video/videoType';

/** The input binary -> a file ffmpeg can seek in, streamed when it lives in n8n's binary store. */

const MB = 1024 * 1024;

export type InputContext = Pick<IExecuteFunctions, 'getInputData' | 'helpers'>;

export type StagedInput = { path: string; fileName: string; bytes: number; meta: IBinaryData };

/** An uninformative type is let through: ffmpeg's probe decides. */
function checkType(meta: IBinaryData, propName: string): Problem | null {
	const mime = normalizeMime(meta.mimeType);
	if (UNINFORMATIVE_MIME.has(mime) || isVideoMime(mime)) return null;
	return {
		message: `Binary property "${propName}" is ${mime}, not a video`,
		description: mime.startsWith('audio/')
			? 'Audio is not supported yet: this node extracts frames from video.'
			: mime.startsWith('image/') || mime === 'application/pdf'
				? 'Images and PDFs can go to Claude as they are. Point Binary Property at the video.'
				: 'Point Binary Property at the video.',
	};
}

const extensionOf = (fileName: string | undefined): string => {
	const match = /\.([a-z0-9]{1,5})$/i.exec(fileName ?? '');
	return match ? match[1].toLowerCase() : 'bin';
};

export async function stageInput(
	ctx: InputContext,
	itemIndex: number,
	propName: string,
	maxVideoMb: number,
	dir: string,
): Promise<StagedInput | { problem: Problem }> {
	const binary = ctx.getInputData()[itemIndex]?.binary ?? {};
	const meta = binary[propName];
	if (!meta) {
		const names = Object.keys(binary).sort();
		return {
			problem: {
				message: `Input item has no binary property named "${propName}"`,
				description: names.length
					? `The item carries these binary properties: ${names.join(', ')}. Set Binary Property to the one holding the video.`
					: 'The item carries no binary data. Read the video into a binary property first, e.g. with Read/Write Files from Disk or HTTP Request.',
			},
		};
	}
	const typeProblem = checkType(meta, propName);
	if (typeProblem) return { problem: typeProblem };

	const bytes = await binarySize(ctx, meta);
	if (bytes > maxVideoMb * MB) {
		return {
			problem: {
				message: `Binary property "${propName}" is ${(bytes / MB).toFixed(1)} MB, over the limit of ${maxVideoMb} MB`,
				description: 'Raise Max Video Size, or trim the video before this node.',
			},
		};
	}
	const fileName = meta.fileName || `${propName}.${meta.fileExtension || 'mp4'}`;
	const path = join(dir, `input.${extensionOf(fileName)}`);
	await writeBinaryFile(ctx, itemIndex, propName, meta, path);
	return { path, fileName, bytes, meta };
}
