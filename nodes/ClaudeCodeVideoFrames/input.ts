import { createWriteStream, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { IBinaryData, IExecuteFunctions } from 'n8n-workflow';
import type { Problem } from '../shared/problem';

/**
 * The input binary -> a file ffmpeg can seek in. A binary with an `id` is in n8n's binary store and
 * is streamed, so a large recording is never held in memory.
 */

const MB = 1024 * 1024;

/** We were told nothing useful: let ffmpeg's probe decide. */
const UNINFORMATIVE = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/** Containers n8n or an upstream service may label with an application/* type. */
const VIDEO_APPLICATION_MIME = new Set([
	'application/mp4',
	'application/x-matroska',
	'application/mxf',
]);

export type InputContext = Pick<IExecuteFunctions, 'getInputData' | 'helpers'>;

export type StagedInput = { path: string; fileName: string; bytes: number; meta: IBinaryData };

function checkType(meta: IBinaryData, propName: string): Problem | null {
	const mime = (meta.mimeType ?? '').toLowerCase().split(';')[0].trim();
	if (UNINFORMATIVE.has(mime) || mime.startsWith('video/') || VIDEO_APPLICATION_MIME.has(mime)) {
		return null;
	}
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

	const fileName = meta.fileName || `${propName}.${meta.fileExtension || 'mp4'}`;
	const path = join(dir, `input.${extensionOf(fileName)}`);
	const tooBig = (bytes: number): Problem => ({
		message: `Binary property "${propName}" is ${(bytes / MB).toFixed(1)} MB, over the limit of ${maxVideoMb} MB`,
		description: 'Raise Max Video Size, or trim the video before this node.',
	});

	if (meta.id) {
		const { fileSize } = await ctx.helpers.getBinaryMetadata(meta.id);
		if (fileSize > maxVideoMb * MB) return { problem: tooBig(fileSize) };
		await pipeline(await ctx.helpers.getBinaryStream(meta.id), createWriteStream(path));
		return { path, fileName, bytes: fileSize, meta };
	}
	const buffer = await ctx.helpers.getBinaryDataBuffer(itemIndex, propName);
	if (buffer.length > maxVideoMb * MB) return { problem: tooBig(buffer.length) };
	writeFileSync(path, buffer);
	return { path, fileName, bytes: buffer.length, meta };
}
