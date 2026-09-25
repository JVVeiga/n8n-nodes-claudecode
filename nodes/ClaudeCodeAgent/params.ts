import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { IExecuteFunctions } from 'n8n-workflow';
import { parseBinaryPropertyNames } from '../ClaudeCode/params';
import type { AttachAllSelection, ClaudeCodeParams, EffortSelection } from '../ClaudeCode/types';
import { readSubNodeParams, usageWorkflowId, type SubNodeOptions } from '../shared/subNodeParams';
import type { OutputMode } from './outputSchema';

export type AgentReadContext = {
	getNodeParameter: IExecuteFunctions['getNodeParameter'];
	getNode: IExecuteFunctions['getNode'];
};

export type SessionMode = 'new' | 'resume';

export type Orchestration = 'auto' | 'required';

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
};

export type AgentParams = { run: ClaudeCodeParams; agent: AgentExtras };

type AgentOptions = Omit<SubNodeOptions, 'effort' | 'maxTurns' | 'timeout'> & {
	permissionMode?: PermissionMode;
	includeTranscript?: boolean;
	allowClaudeAiConnectors?: boolean;
};

export const parseInstructionFiles = (raw: string): string[] =>
	raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== '');

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
		prompt: ctx.getNodeParameter('prompt', itemIndex, '') as string,
		attachments: {
			...base.attachments,
			all: resolveAgentAttachAll(
				ctx.getNodeParameter('attachAllBinaries', itemIndex, 'auto') as AttachAllSelection,
			),
			names: parseBinaryPropertyNames(
				ctx.getNodeParameter('binaryProperties', itemIndex, '') as string,
			),
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
				ctx.getNodeParameter('instructionFiles', itemIndex, '') as string,
			),
			session: {
				mode: ctx.getNodeParameter('sessionMode', itemIndex, 'new') as SessionMode,
				key: (ctx.getNodeParameter('sessionKey', itemIndex, '') as string).trim(),
			},
			orchestration: ctx.getNodeParameter(
				'subagentOrchestration',
				itemIndex,
				'auto',
			) as Orchestration,
			allowConnectors: options.allowClaudeAiConnectors === true,
			includeTranscript: options.includeTranscript === true,
			usageWorkflowId: usageWorkflowId(options.reportUsageTo),
			processName: (options.processName ?? '').trim(),
		},
	};
}

/** A `json` parameter set by an expression can arrive already parsed. */
const stringify = (value: unknown): string =>
	typeof value === 'string'
		? value
		: value === undefined || value === null
			? ''
			: JSON.stringify(value);
