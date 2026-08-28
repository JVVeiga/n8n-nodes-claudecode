import type { IExecuteFunctions } from 'n8n-workflow';
import type { Problem } from '../../shared/problem';
import { effectiveMime } from './mime';
import { resolveFileName } from './name';
import type { Attachment, AttachmentSpec } from './types';

/**
 * Turning n8n binary properties into bytes.
 *
 * The only module in the attachment path that touches `IExecuteFunctions`, and the only one that
 * reads a buffer from anywhere — the same role `readUsage.ts` plays for the Usage node. Everything
 * downstream of here takes an `Attachment[]` and is a pure function of it.
 *
 * `ctx.helpers.getBinaryDataBuffer` rather than `binary[name].data`: n8n stores binary data either
 * inline as base64 or on a filesystem, depending on `N8N_DEFAULT_BINARY_DATA_MODE`, and the helper
 * is what hides that difference. Reading `.data` directly works until an instance switches mode.
 *
 * A failure is returned as a `Problem`, never thrown, exactly like `checkProjectPath` and
 * `checkPrompt`: the node already has the `itemIndex` and the node instance needed to build a
 * proper `NodeOperationError`, and returning keeps this testable against a fake context.
 */

export type CollectOutcome = { attachments: Attachment[] } | { problem: Problem };

const MB = 1024 * 1024;

const formatMb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

/** Which binary properties to read, in the order the model will see them. */
function selectPropertyNames(spec: AttachmentSpec, binary: Record<string, unknown>): string[] {
	// Sorted, not insertion order: a Monday item's data_0..data_9 arrive in whatever order the
	// upstream node happened to build them, and the sequence the model sees should not change
	// between two runs over the same data.
	if (spec.all) return Object.keys(binary).sort();
	return spec.names;
}

export async function collectAttachments(
	ctx: IExecuteFunctions,
	itemIndex: number,
	spec: AttachmentSpec,
): Promise<CollectOutcome> {
	const item = ctx.getInputData()[itemIndex];
	const binary = (item?.binary ?? {}) as Record<
		string,
		{ fileName?: string; fileExtension?: string; mimeType?: string }
	>;

	const propNames = selectPropertyNames(spec, binary);
	if (propNames.length === 0) return { attachments: [] };

	// Count first, so a 40-property item says "too many attachments" rather than naming whichever
	// file happened to be oversized. The count is the thing the user has to fix.
	if (propNames.length > spec.maxAttachmentCount) {
		return {
			problem: {
				message: `Too many attachments: ${propNames.length}, over the limit of ${spec.maxAttachmentCount}`,
				description:
					'Raise Max Attachment Count in Additional Options, or name fewer properties in Binary Properties.',
			},
		};
	}

	const maxBytes = spec.maxAttachmentMb * MB;
	const attachments: Attachment[] = [];
	const usedNames = new Set<string>();

	for (const propName of propNames) {
		const meta = binary[propName];
		if (!meta) {
			return {
				problem: {
					message: `Input item has no binary property named "${propName}"`,
					description: `The item carries ${
						Object.keys(binary).length === 0
							? 'no binary data at all'
							: `these binary properties: ${Object.keys(binary).sort().join(', ')}`
					}. Check the name, or turn on Attach All Binaries.`,
				},
			};
		}

		const buffer = await ctx.helpers.getBinaryDataBuffer(itemIndex, propName);
		if (buffer.length > maxBytes) {
			return {
				problem: {
					message: `Binary property "${propName}" is ${formatMb(buffer.length)}, over the limit of ${spec.maxAttachmentMb} MB`,
					description:
						'Raise Max Attachment Size in Additional Options, or drop the file from this request.',
				},
			};
		}

		const fileName = resolveFileName(meta, propName, usedNames);
		usedNames.add(fileName);

		attachments.push({
			propName,
			fileName,
			// Resolved once, here, so the route, the debug log and the diagnostics all report the
			// same type — including when n8n reported none and the extension or the bytes decided.
			mimeType: effectiveMime(meta.mimeType, fileName, buffer),
			bytes: buffer.length,
			buffer,
		});
	}

	return { attachments };
}
