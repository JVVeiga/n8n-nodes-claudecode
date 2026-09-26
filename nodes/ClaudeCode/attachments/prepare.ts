import type { IExecuteFunctions } from 'n8n-workflow';
import type { Problem } from '../../shared/problem';
import type { PromptContent } from '../promptStream';
import { collectAttachments } from './collect';
import { planAttachments, stagedHintBlock } from './plan';
import { stageAttachments } from './stage';
import type { AttachmentPlan, AttachmentSpec, StagedAttachments } from './types';

export type PreparedAttachments = {
	plan: AttachmentPlan;
	/** Non-null once files are on disk; the caller must clean it up on every exit path. */
	staged: StagedAttachments | null;
	promptContent: PromptContent;
};

/**
 * collect -> plan -> stage -> the user turn, for any node that sends a prompt with attachments.
 * `trailing` is text that follows the prompt in the same turn.
 */
export async function prepareAttachments(
	ctx: IExecuteFunctions,
	itemIndex: number,
	spec: AttachmentSpec,
	prompt: string,
	trailing: string[] = [],
): Promise<PreparedAttachments | { problem: Problem }> {
	const collected = await collectAttachments(ctx, itemIndex, spec);
	if ('problem' in collected) return collected;
	const plan = planAttachments(collected.attachments, spec, collected.skipped);
	let staged: StagedAttachments | null = null;
	if (plan.toStage.length > 0) {
		staged = stageAttachments(plan.toStage);
		if (plan.report?.staged) plan.report.staged.dir = staged.dir;
	}

	// Attachments first, prompt last: content before the question is Anthropic's guidance
	// for documents, and it reads as "here are the files, here is what I want". With no
	// attachments this stays the plain string it has always been — no blocks, no fs call.
	const promptContent: PromptContent =
		plan.blocks.length === 0 && staged === null && trailing.length === 0
			? prompt
			: [
					...plan.blocks,
					...(staged ? [stagedHintBlock(staged.dir, plan.report?.staged?.files ?? [])] : []),
					{ type: 'text' as const, text: prompt },
					...trailing.map((text) => ({ type: 'text' as const, text })),
				];

	return { plan, staged, promptContent };
}
