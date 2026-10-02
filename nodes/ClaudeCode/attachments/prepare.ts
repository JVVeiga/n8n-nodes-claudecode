import type { IExecuteFunctions } from 'n8n-workflow';
import type { Problem } from '../../shared/problem';
import type { PromptContent } from '../promptStream';
import { collectAttachments } from './collect';
import { planAttachments, stagedHintBlock } from './plan';
import { stageAttachments } from './stage';
import type { Attachment, AttachmentPlan, AttachmentSpec, StagedAttachments } from './types';
import { defaultVideoDeps, framesHintBlock, prepareVideos, type VideoDeps } from './video';

export type PreparedAttachments = {
	plan: AttachmentPlan;
	/** Non-null once files are on disk; the caller must clean it up on every exit path. */
	staged: StagedAttachments | null;
	promptContent: PromptContent;
};

/**
 * How long extracting a video's frames may take, what cancels it, and whether copies of the
 * frames go to disk for subagents (the Agent from 1.3, when it has one).
 */
export type PrepareRun = {
	timeoutMs: number;
	signal?: AbortSignal;
	stageVideoFrames?: boolean;
	videoDeps?: VideoDeps;
};

/**
 * collect -> plan -> videos -> stage -> the user turn, for any node that sends a prompt with
 * attachments. `trailing` is text that follows the prompt in the same turn.
 */
export async function prepareAttachments(
	ctx: IExecuteFunctions,
	itemIndex: number,
	spec: AttachmentSpec,
	prompt: string,
	trailing: string[] = [],
	run: PrepareRun = { timeoutMs: 300_000 },
): Promise<PreparedAttachments | { problem: Problem }> {
	const collected = await collectAttachments(ctx, itemIndex, spec);
	if ('problem' in collected) return collected;
	const plan = planAttachments(collected.attachments, spec, collected.skipped);
	let frameFiles: Attachment[] = [];

	// Videos after the other attachments, before the prompt. The report keeps `videos` absent
	// unless one was converted, so no other run's output moves.
	if (collected.videos.length > 0) {
		const otherImages = plan.report?.inline.filter((a) => a.as === 'image').length ?? 0;
		const videos = await prepareVideos(
			ctx,
			itemIndex,
			collected.videos,
			spec,
			otherImages,
			{ timeoutMs: run.timeoutMs, signal: run.signal, stageFrames: run.stageVideoFrames },
			run.videoDeps ?? defaultVideoDeps,
		);
		if ('problem' in videos) return videos;
		plan.blocks.push(...videos.blocks);
		frameFiles = videos.frameFiles.map((f) => ({ ...f, bytes: f.buffer.length }));
		const base = plan.report ?? {
			count: 0,
			totalBytes: 0,
			skipped: collected.skipped,
			inline: [],
			staged: null,
		};
		plan.report = {
			...base,
			count: base.count + collected.videos.length,
			totalBytes: base.totalBytes + collected.videos.reduce((sum, v) => sum + v.bytes, 0),
			videos: videos.reports,
		};
		plan.notes = {
			...plan.notes,
			attachmentVideos: videos.reports.map(
				(v) => `${v.name}: ${v.images} ${v.mode} image(s), ${v.strategy}, ${v.elapsedMs} ms`,
			),
		};
	}
	// Frames share the staging directory and its cleanup, but not `report.staged`, which lists
	// the files that could not go inline: these did.
	let staged: StagedAttachments | null = null;
	if (plan.toStage.length + frameFiles.length > 0) {
		staged = stageAttachments([...plan.toStage, ...frameFiles]);
		if (plan.report?.staged) plan.report.staged.dir = staged.dir;
		for (const video of plan.report?.videos ?? []) {
			if (video.stagedFrames) video.stagedFrames.dir = staged.dir;
		}
	}

	// Attachments first, prompt last: content before the question is Anthropic's guidance
	// for documents, and it reads as "here are the files, here is what I want". With no
	// attachments this stays the plain string it has always been — no blocks, no fs call.
	const promptContent: PromptContent =
		plan.blocks.length === 0 && staged === null && trailing.length === 0
			? prompt
			: [
					...plan.blocks,
					...(staged && plan.toStage.length > 0
						? [stagedHintBlock(staged.dir, plan.report?.staged?.files ?? [])]
						: []),
					...(staged && frameFiles.length > 0
						? [framesHintBlock(staged.dir, plan.report?.videos ?? [])]
						: []),
					{ type: 'text' as const, text: prompt },
					...trailing.map((text) => ({ type: 'text' as const, text })),
				];

	return { plan, staged, promptContent };
}
