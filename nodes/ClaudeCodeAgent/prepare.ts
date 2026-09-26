import type { IExecuteFunctions } from 'n8n-workflow';
import type { AuthSelection } from '../shared/auth';
import type { Problem } from '../shared/problem';
import { checkProjectPath } from '../shared/projectPath';
import { readAuth } from '../shared/readAuth';
import { toSessionUuid } from '../shared/session';
import { checkPrompt } from '../ClaudeCode/params';
import type { ClaudeCodeParams } from '../ClaudeCode/types';
import { checkToolNames, readConnections, type AgentConnections } from './connections';
import { readInstructions, type Instructions } from './instructions';
import { resolveOutputSchema } from './outputSchema';
import type { AgentExtras } from './params';
import { buildSubagents, type Subagents } from './subagents';
import { checkVerification } from './verification/select';

export type PreparedAgent = {
	/** Null when Session is New. */
	sessionUuid: string | null;
	auth: AuthSelection;
	connections: AgentConnections;
	subagents: Subagents;
	subagentNames: string[];
	schema: { schema: Record<string, unknown> } | null;
	instructions: Instructions | null;
};

/** Every check that can refuse the item, in order, before a file is staged or a process spawned. */
export async function prepareAgentRun(
	ctx: IExecuteFunctions,
	itemIndex: number,
	params: ClaudeCodeParams,
	agent: AgentExtras,
): Promise<PreparedAgent | { problem: Problem }> {
	const promptProblem = checkPrompt(params.prompt);
	if (promptProblem) return { problem: promptProblem };

	const resume = agent.session.mode === 'resume';
	if (resume && agent.session.key === '') {
		return {
			problem: {
				message: 'Session is set to Resume, but Session ID or Key is empty',
				description:
					'Put a stable key for the conversation in Session ID or Key — a ticket, chat or user id, e.g. {{ $json.ticketId }} — or set Session to New.',
			},
		};
	}
	const sessionUuid = resume ? toSessionUuid(agent.session.key) : null;

	const authOutcome = await readAuth(ctx, itemIndex);
	if ('problem' in authOutcome) return authOutcome;

	const connections = await readConnections(ctx, itemIndex);
	const toolNameProblem = checkToolNames(connections.tools);
	if (toolNameProblem) return { problem: toolNameProblem };
	const subagents = buildSubagents(connections.subagents);
	if ('problem' in subagents) return subagents;

	const schema = resolveOutputSchema(agent.outputMode, agent.jsonSchemaText, connections.parser);
	if (schema && 'problem' in schema) return schema;
	const verificationProblem = checkVerification(agent.verification, agent.outputMode);
	if (verificationProblem) return { problem: verificationProblem };

	const pathProblem = checkProjectPath(params.projectPath);
	if (pathProblem) return { problem: pathProblem };

	const instructions =
		agent.instructionFiles.length > 0
			? readInstructions(params.projectPath, agent.instructionFiles)
			: null;
	if (instructions && 'problem' in instructions) return instructions;

	return {
		sessionUuid,
		auth: authOutcome.auth,
		connections,
		subagents,
		subagentNames: Object.keys(subagents.agents),
		schema,
		instructions,
	};
}
