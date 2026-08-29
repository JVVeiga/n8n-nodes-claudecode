import type { IExecuteFunctions } from 'n8n-workflow';
import type { Problem } from '../shared/problem';
import type { AttachmentSpec } from './attachments/types';
import type {
	AdditionalOptions,
	ClaudeCodeParams,
	EffortSelection,
	Operation,
	OutputFormat,
} from './types';

/**
 * The one place that touches `IExecuteFunctions` to read parameters.
 *
 * Everything downstream — config building, diagnostics, output shaping — takes a
 * `ClaudeCodeParams` and is therefore a pure function of plain data. That is the whole point of
 * this file: it is the boundary where n8n stops and the node's own logic starts.
 */

/** The version-aware default for the wrap-up grace, applied here because the declarative schema
 * cannot vary a default by typeVersion and an unset collection field arrives as undefined.
 * typeVersion 1 predates the graceful stop, so it gets 0 and keeps hard-killing. */
export const defaultGraceSeconds = (nodeVersion: number): number => (nodeVersion >= 1.1 ? 60 : 0);

/** Defaults for the three attachment limits. Restated here rather than read from the schema
 * because an unset collection field arrives as `undefined`, exactly like `wrapUpGraceSeconds`. */
const ATTACHMENT_DEFAULTS = {
	inlineTextLimitKb: 256,
	maxAttachmentMb: 50,
	maxAttachmentCount: 16,
} as const;

/** Split the Binary Properties field on commas and whitespace, dropping empties. */
export const parseBinaryPropertyNames = (raw: string): string[] =>
	raw
		.split(/[\s,]+/)
		.map((name) => name.trim())
		.filter((name) => name !== '');

function readAttachmentSpec(
	ctx: IExecuteFunctions,
	itemIndex: number,
	additional: AdditionalOptions,
): AttachmentSpec {
	return {
		// The fallback is `false` while the schema default is `true`, and that mismatch is the
		// point. n8n resolves a parameter with `get(node.parameters, name, fallbackValue)`
		// (node-execution-context.js), so it never consults the schema at run time: a node saved
		// before this parameter existed has no key and lands here, on `false`. The schema default
		// is only what the editor writes into a newly added node. Matching them would make a
		// package upgrade start attaching files in every stored workflow that carries binary data.
		all: ctx.getNodeParameter('attachAllBinaries', itemIndex, false) as boolean,
		names: parseBinaryPropertyNames(
			ctx.getNodeParameter('binaryProperties', itemIndex, '') as string,
		),
		// `??`, not `||`: 0 is a meaningful value for the text limit — it means "stage every text
		// file" — and `||` would silently turn it back into 256.
		inlineTextLimitKb: additional.inlineTextLimitKb ?? ATTACHMENT_DEFAULTS.inlineTextLimitKb,
		maxAttachmentMb: additional.maxAttachmentMb ?? ATTACHMENT_DEFAULTS.maxAttachmentMb,
		maxAttachmentCount: additional.maxAttachmentCount ?? ATTACHMENT_DEFAULTS.maxAttachmentCount,
	};
}

export function readParams(ctx: IExecuteFunctions, itemIndex: number): ClaudeCodeParams {
	const nodeVersion = ctx.getNode().typeVersion;
	const additional = ctx.getNodeParameter('additionalOptions', itemIndex) as AdditionalOptions;

	return {
		operation: ctx.getNodeParameter('operation', itemIndex) as Operation,
		// Read for every operation, not just `continue`: reading it conditionally meant the shape of
		// the params object depended on the operation, and every consumer had to know that.
		sessionId: (ctx.getNodeParameter('sessionId', itemIndex, '') as string).trim(),
		prompt: ctx.getNodeParameter('prompt', itemIndex) as string,
		model: ctx.getNodeParameter('model', itemIndex) as string,
		effort: ctx.getNodeParameter('effort', itemIndex, 'high') as EffortSelection,
		maxTurns: ctx.getNodeParameter('maxTurns', itemIndex) as number,
		timeoutSeconds: ctx.getNodeParameter('timeout', itemIndex) as number,
		projectPath: ctx.getNodeParameter('projectPath', itemIndex) as string,
		outputFormat: ctx.getNodeParameter('outputFormat', itemIndex) as OutputFormat,
		allowedTools: ctx.getNodeParameter('allowedTools', itemIndex, []) as string[],
		disallowedTools: ctx.getNodeParameter('disallowedTools', itemIndex, []) as string[],
		restrictTools: ctx.getNodeParameter('restrictTools', itemIndex, []) as string[],
		// Read for every operation, like sessionId above and for the same reason: a params object
		// whose shape depends on the operation makes every consumer know about the operation.
		attachments: readAttachmentSpec(ctx, itemIndex, additional),
		additional: {
			...additional,
			wrapUpGraceSeconds: additional.wrapUpGraceSeconds ?? defaultGraceSeconds(nodeVersion),
		},
		nodeVersion,
		itemIndex,
	};
}

/**
 * Ultracode is the top of the Effort selector, matching Claude Code's own UI: xHigh effort plus
 * standing dynamic-workflow orchestration. It is not an SDK effort level, so it is translated
 * before anything reaches the SDK.
 */
export const isUltracode = (params: ClaudeCodeParams): boolean => params.effort === 'ultracode';

/** The effort level actually sent to the SDK. Only Ultracode is translated; the rest pass through. */
export const effectiveEffort = (params: ClaudeCodeParams) =>
	params.effort === 'ultracode' ? 'xhigh' : params.effort;

/**
 * Returns a Problem when the prompt is unusable, null otherwise.
 *
 * Worth knowing: this is unreachable from a literal empty value. `prompt` is declared
 * `required: true`, so n8n rejects the whole workflow in its own pre-flight check
 * (`WorkflowExecute.checkForWorkflowIssues`, "Parameter 'Prompt' is required") and the node never
 * runs. The guard exists for the case that DOES reach it: an expression such as
 * `{{ $json.missing }}` that passes static validation and resolves to empty at run time.
 */
export function checkPrompt(prompt: string): Problem | null {
	if (prompt && prompt.trim() !== '') return null;
	// No description, deliberately: the pre-refactor error carried none, and adding one would
	// change what n8n displays and what reaches the error output. Logged as a 1.2 candidate
	// (F-04) rather than slipped in here.
	return { message: 'Prompt is required and cannot be empty' };
}
