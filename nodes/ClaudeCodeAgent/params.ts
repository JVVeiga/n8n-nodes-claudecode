import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { IExecuteFunctions } from 'n8n-workflow';
import { parseBinaryPropertyNames } from '../ClaudeCode/params';
import type { AttachAllSelection, ClaudeCodeParams, EffortSelection } from '../ClaudeCode/types';
import { readSubNodeParams, usageWorkflowId, type SubNodeOptions } from '../shared/subNodeParams';
import { text } from '../shared/text';
import type { OutputMode } from './outputSchema';
import { DEFAULT_VERIFIER_INSTRUCTIONS } from './verification/prompt';
import type { ItemFilter } from './verification/select';

export type AgentReadContext = {
	getNodeParameter: IExecuteFunctions['getNodeParameter'];
	getNode: IExecuteFunctions['getNode'];
};

export type SessionMode = 'new' | 'resume';

export type Orchestration = 'auto' | 'required';

export type VerificationParams = {
	itemsPath: string;
	filter: ItemFilter | null;
	instructions: string;
};

export type AgentExtras = {
	outputMode: OutputMode;
	jsonSchemaText: string;
	instructionFiles: string[];
	session: { mode: SessionMode; key: string };
	orchestration: Orchestration;
	allowConnectors: boolean;
	includeTranscript: boolean;
	/** Empty when the node was not asked to report. */
	usageWorkflowId: string;
	processName: string;
	/** Null when Verification is not enabled. */
	verification: VerificationParams | null;
};

export type AgentParams = { run: ClaudeCodeParams; agent: AgentExtras };

type AgentOptions = Omit<SubNodeOptions, 'effort' | 'maxTurns' | 'timeout'> & {
	permissionMode?: PermissionMode;
	includeTranscript?: boolean;
	allowClaudeAiConnectors?: boolean;
};

/** A list field: an array from an expression is taken as the list, text is split. */
const list = (value: unknown, separator: RegExp | string): string[] =>
	(Array.isArray(value) ? value.map(text) : text(value).split(separator))
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '');

export const parseInstructionFiles = (raw: unknown): string[] => list(raw, /\r?\n/);

/** The Agent is a new node, so Attach All's `auto` means on, as it does from Claude Code 1.3. */
export const resolveAgentAttachAll = (selection: AttachAllSelection): boolean =>
	selection !== 'off';

export function readAgentParams(ctx: AgentReadContext, itemIndex: number): AgentParams {
	const options = ctx.getNodeParameter('options', itemIndex, {}) as AgentOptions;
	const base = readSubNodeParams(ctx, itemIndex, {
		...options,
		effort: ctx.getNodeParameter('effort', itemIndex, 'high') as EffortSelection,
		maxTurns: ctx.getNodeParameter('maxTurns', itemIndex, 25) as number,
		timeout: ctx.getNodeParameter('timeout', itemIndex, 300) as number,
	});

	const run: ClaudeCodeParams = {
		...base,
		prompt: text(ctx.getNodeParameter('prompt', itemIndex, '')),
		attachments: {
			...base.attachments,
			all: resolveAgentAttachAll(
				ctx.getNodeParameter('attachAllBinaries', itemIndex, 'auto') as AttachAllSelection,
			),
			names: parseBinaryPropertyNames(ctx.getNodeParameter('binaryProperties', itemIndex, '')),
		},
		additional: {
			...base.additional,
			permissionMode: options.permissionMode || 'bypassPermissions',
		},
	};

	return {
		run,
		agent: {
			outputMode: ctx.getNodeParameter('outputMode', itemIndex, 'text') as OutputMode,
			jsonSchemaText: stringify(ctx.getNodeParameter('jsonSchema', itemIndex, '')),
			instructionFiles: parseInstructionFiles(
				ctx.getNodeParameter('instructionFiles', itemIndex, ''),
			),
			session: {
				mode: ctx.getNodeParameter('sessionMode', itemIndex, 'new') as SessionMode,
				key: text(ctx.getNodeParameter('sessionKey', itemIndex, '')).trim(),
			},
			orchestration: ctx.getNodeParameter(
				'subagentOrchestration',
				itemIndex,
				'auto',
			) as Orchestration,
			allowConnectors: options.allowClaudeAiConnectors === true,
			includeTranscript: options.includeTranscript === true,
			usageWorkflowId: usageWorkflowId(options.reportUsageTo),
			processName: text(options.processName).trim(),
			verification: readVerification(ctx.getNodeParameter('verification', itemIndex, {})),
		},
	};
}

type VerificationInput = {
	enabled?: boolean;
	itemsPath?: unknown;
	filterField?: unknown;
	filterValues?: unknown;
	instructions?: unknown;
};

export function readVerification(raw: unknown): VerificationParams | null {
	const input = (raw ?? {}) as VerificationInput;
	if (input.enabled !== true) return null;
	const field = text(input.filterField).trim();
	return {
		itemsPath: text(input.itemsPath).trim(),
		filter: field ? { field, values: list(input.filterValues, ',') } : null,
		instructions: text(input.instructions).trim() || DEFAULT_VERIFIER_INSTRUCTIONS,
	};
}

/** A `json` parameter set by an expression can arrive already parsed. */
const stringify = (value: unknown): string =>
	typeof value === 'string'
		? value
		: value === undefined || value === null
			? ''
			: JSON.stringify(value);
