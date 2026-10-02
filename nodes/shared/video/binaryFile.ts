import { createWriteStream, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { IBinaryData, IExecuteFunctions } from 'n8n-workflow';

/**
 * An n8n binary -> its size and a file on disk, without holding a large one in memory. A binary
 * with an `id` lives in n8n's binary store (filesystem or S3 mode) and is streamed; one without is
 * inline base64, already in memory.
 */

export type BinaryFileContext = Pick<IExecuteFunctions, 'helpers'>;

export async function binarySize(ctx: BinaryFileContext, meta: IBinaryData): Promise<number> {
	if (meta.id) return (await ctx.helpers.getBinaryMetadata(meta.id)).fileSize;
	return Buffer.byteLength(meta.data ?? '', 'base64');
}

export async function writeBinaryFile(
	ctx: BinaryFileContext,
	itemIndex: number,
	propName: string,
	meta: IBinaryData,
	path: string,
): Promise<void> {
	if (meta.id) {
		await pipeline(await ctx.helpers.getBinaryStream(meta.id), createWriteStream(path));
		return;
	}
	writeFileSync(path, await ctx.helpers.getBinaryDataBuffer(itemIndex, propName));
}
