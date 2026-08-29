import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { routeFor } from './mime';
import type {
	Attachment,
	AttachmentDiagnostics,
	AttachmentPlan,
	AttachmentSpec,
	InlineKind,
	Route,
	SkippedAttachment,
} from './types';

/**
 * Building the user turn.
 *
 * Pure: takes attachments and the spec, returns blocks, a staging list, a diagnostics record and
 * debug notes. Nothing here writes, spawns or reads. That is what makes "what exactly does the
 * model receive" a unit test rather than an E2E run.
 */

const KB = 1024;

const formatSize = (bytes: number): string =>
	bytes < KB
		? `${bytes} B`
		: bytes < KB * KB
			? `${Math.round(bytes / KB)} KB`
			: `${(bytes / (KB * KB)).toFixed(1)} MB`;

/**
 * The blocks for one attachment.
 *
 * An image gets a naming text block in front of it. `ImageBlockParam` carries only `source`,
 * `type` and `cache_control` — there is no `title` field — so without this a prompt saying "the
 * error in screenshot.png" has no way to be matched to the image that follows.
 */
function inlineBlocks(attachment: Attachment, route: Route): ContentBlockParam[] {
	const data = attachment.buffer.toString('base64');

	switch (route.kind) {
		case 'image':
			return [
				{
					type: 'text',
					text: `Image: ${attachment.fileName} (${formatSize(attachment.bytes)}, ${attachment.mimeType})`,
				},
				{ type: 'image', source: { type: 'base64', media_type: route.mediaType, data } },
			];
		case 'document-pdf':
			return [
				{
					type: 'document',
					title: attachment.fileName,
					source: { type: 'base64', media_type: 'application/pdf', data },
				},
			];
		case 'document-text':
			return [
				{
					type: 'document',
					title: attachment.fileName,
					source: {
						type: 'text',
						media_type: 'text/plain',
						data: attachment.buffer.toString('utf8'),
					},
				},
			];
		case 'staged':
			return [];
	}
}

/**
 * What to tell the model about files that went to disk instead of into the turn.
 *
 * Built here but appended by the node, because the real directory path only exists once
 * `stage.ts` has run. It belongs to the user turn rather than the system prompt: the `systemPrompt`
 * applier already owns the preset's `append` slot, and two appenders would silently fight over it.
 */
export function stagedHintBlock(
	dir: string,
	files: { name: string; mimeType: string; bytes: number }[],
): ContentBlockParam {
	const lines = files.map((f) => `  ${f.name} (${formatSize(f.bytes)}, ${f.mimeType})`);
	return {
		type: 'text',
		text: [
			`<attachments-on-disk dir="${dir}">`,
			...lines,
			'</attachments-on-disk>',
			'These files were not included in this message because of their size or type. Read them from that directory with the Read tool when you need them.',
		].join('\n'),
	};
}

/** The `as` value reported in diagnostics for an inlined attachment. */
const inlineKindOf = (route: Route): InlineKind | null =>
	route.kind === 'staged' ? null : route.kind;

export function planAttachments(
	attachments: Attachment[],
	spec: AttachmentSpec,
	skipped: SkippedAttachment[] = [],
): AttachmentPlan {
	// The empty case matters: it is what guarantees a run with no attachments configured builds no
	// blocks, makes no filesystem call, and emits no `attachments` key in diagnostics — which is
	// what keeps the 48 golden fixtures byte-identical.
	//
	// `skipped` is checked too: an item whose every file the extension filter excluded still has
	// something to report, and reporting it is the whole reason a skip is allowed to be silent in
	// the run itself.
	if (attachments.length === 0 && skipped.length === 0) {
		return { blocks: [], toStage: [], report: null, notes: {} };
	}

	const blocks: ContentBlockParam[] = [];
	const toStage: Attachment[] = [];
	const inline: AttachmentDiagnostics['inline'] = [];
	const routes: Record<string, string> = {};

	for (const attachment of attachments) {
		const route = routeFor(attachment.mimeType, attachment.bytes, spec);

		routes[attachment.fileName] =
			route.kind === 'staged'
				? `staged (${route.reason})`
				: route.kind === 'image'
					? `image (${route.mediaType})`
					: route.kind;

		if (route.kind === 'staged') {
			toStage.push(attachment);
			continue;
		}

		blocks.push(...inlineBlocks(attachment, route));
		const as = inlineKindOf(route);
		if (as) {
			inline.push({
				name: attachment.fileName,
				mimeType: attachment.mimeType,
				bytes: attachment.bytes,
				as,
			});
		}
	}

	const report: AttachmentDiagnostics = {
		// The count of what was SENT. A skipped file is reported separately rather than folded in,
		// because "3 attachments" meaning "2 sent and 1 dropped" is how a wrong answer gets missed.
		count: attachments.length,
		totalBytes: attachments.reduce((sum, a) => sum + a.bytes, 0),
		skipped,
		inline,
		// The directory is unknown until stage.ts runs, so the node fills it in. Null here means
		// "nothing to stage", which is a different thing and is what the node leaves alone.
		staged:
			toStage.length === 0
				? null
				: {
						dir: '',
						files: toStage.map((a) => ({
							name: a.fileName,
							mimeType: a.mimeType,
							bytes: a.bytes,
						})),
					},
	};

	return {
		blocks,
		toStage,
		report,
		notes: {
			attachmentCount: attachments.length,
			attachmentRoutes: routes,
			attachmentInlineBlocks: blocks.length,
			attachmentStaged: toStage.length,
			...(skipped.length > 0
				? {
						attachmentSkipped: skipped.length,
						attachmentSkippedFiles: skipped.map((sk) => `${sk.fileName} (.${sk.extension})`),
					}
				: {}),
		},
	};
}
