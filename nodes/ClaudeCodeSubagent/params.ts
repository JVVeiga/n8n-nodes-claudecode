import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { IExecuteFunctions } from 'n8n-workflow';
import type { Problem } from '../shared/problem';
import { INHERIT } from './description';

export type SubagentReadContext = {
	getNodeParameter: IExecuteFunctions['getNodeParameter'];
};

export type SubagentParams = { name: string; enabled: boolean; definition: AgentDefinition };

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

// An expression can resolve to anything. Guessing would either pay for a subagent nobody wanted or
// silently skip a mandatory one, so only true and false are accepted.
const toEnabled = (raw: unknown): boolean | null => {
	if (typeof raw === 'boolean') return raw;
	const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
	return text === 'true' ? true : text === 'false' ? false : null;
};

const shown = (raw: unknown): string =>
	typeof raw === 'string' ? `'${raw}'` : String(JSON.stringify(raw) ?? raw);

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

	const rawEnabled: unknown = ctx.getNodeParameter('enabled', itemIndex, true);
	const enabled = toEnabled(rawEnabled);
	if (enabled === null) {
		return {
			problem: {
				message: `The subagent '${name}' has Enabled set to ${shown(rawEnabled)}, which is neither true nor false.`,
				description:
					'Enabled must resolve to true or false. An expression that points at a missing field resolves to undefined — check the field name.',
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
		enabled,
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
