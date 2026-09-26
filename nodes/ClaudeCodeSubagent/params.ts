import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { IExecuteFunctions } from 'n8n-workflow';
import type { Problem } from '../shared/problem';
import { INHERIT } from './description';

export type SubagentReadContext = {
	getNodeParameter: IExecuteFunctions['getNodeParameter'];
};

export type SubagentParams = { name: string; definition: AgentDefinition };

type SubagentOptions = {
	effort?: string;
	maxTurns?: number;
	tools?: string[];
	extraTools?: string;
	disallowedTools?: string;
	omitClaudeMd?: boolean;
};

type Effort = Exclude<AgentDefinition['effort'], number | undefined>;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const splitNames = (raw: string | undefined): string[] =>
	(raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

const unique = (names: string[]): string[] => [...new Set(names)];

/** The only place this node reads parameters. */
export function readSubagentParams(
	ctx: SubagentReadContext,
	itemIndex: number,
): SubagentParams | { problem: Problem } {
	const name = String(ctx.getNodeParameter('agentName', itemIndex, '')).trim();
	if (!NAME_PATTERN.test(name)) {
		return {
			problem: {
				message: `The subagent name '${name}' is not valid.`,
				description:
					'Use lowercase letters, digits and hyphens, starting with a letter or digit — e.g. code-reviewer.',
			},
		};
	}

	const description = String(ctx.getNodeParameter('whenToUse', itemIndex, '')).trim();
	const prompt = String(ctx.getNodeParameter('instructions', itemIndex, '')).trim();
	if (!description || !prompt) {
		return {
			problem: {
				message: `The subagent '${name}' needs both When to Use and Instructions.`,
				description:
					'When to Use tells the Agent when to delegate; Instructions are what the subagent follows.',
			},
		};
	}

	const model = String(ctx.getNodeParameter('model', itemIndex, INHERIT));
	const options = ctx.getNodeParameter('options', itemIndex, {}) as SubagentOptions;
	const tools = unique([...(options.tools ?? []), ...splitNames(options.extraTools)]);
	const disallowedTools = unique(splitNames(options.disallowedTools));
	const effort = options.effort && options.effort !== INHERIT ? options.effort : undefined;
	const maxTurns = options.maxTurns ?? 0;

	return {
		name,
		definition: {
			description,
			prompt,
			// 'inherit' is the SDK's own value for "the main model"; an omitted model would instead
			// fall back to a configured default subagent model.
			model,
			...(effort ? { effort: effort as Effort } : {}),
			...(maxTurns > 0 ? { maxTurns } : {}),
			...(tools.length ? { tools } : {}),
			...(disallowedTools.length ? { disallowedTools } : {}),
			...(options.omitClaudeMd === true ? { omitClaudeMd: true } : {}),
		},
	};
}
