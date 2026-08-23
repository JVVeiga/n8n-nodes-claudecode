import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { DebugLogger } from '../shared/debug';

/**
 * Per-message debug logging.
 *
 * Roughly seventy-five lines of this were interleaved into the message loop, which made the loop
 * about half logging by line count and hid the one thing it actually does: close the input stream
 * when the run ends. Moving it out is what made runner.ts readable.
 *
 * Deliberately kept verbatim rather than tidied: these fields are what someone stares at when a run
 * misbehaves in production, and the shapes are already familiar from existing debug output.
 *
 * Switched on `message.type` rather than chained through the shared type guards. Chaining them with
 * early returns narrows the union negatively at each step, and `SDKMessage` is not discriminated
 * cleanly enough for that to survive — the last branch collapses to `never`. A switch with one
 * local view type per case is honest about what it reads.
 */

type MessageView = {
	type: string;
	subtype?: string;
	model?: string;
	tools?: string[];
	message?: { content?: unknown };
	result?: unknown;
	errors?: string[];
	duration_ms?: number;
	total_cost_usd?: number;
};

type Block = { type?: string; text?: string; name?: string };

const blocksOf = (view: MessageView): Block[] => {
	const content = view.message?.content;
	return Array.isArray(content) ? (content as Block[]) : [];
};

export function logMessage(debug: DebugLogger, message: SDKMessage): void {
	if (!debug.enabled) return;
	const view = message as unknown as MessageView;

	switch (view.type) {
		case 'system': {
			if (view.subtype !== 'init') break;
			debug.log('System init message', {
				type: view.type,
				subtype: view.subtype,
				model: view.model,
				toolCount: view.tools?.length || 0,
			});
			return;
		}

		case 'assistant': {
			const blocks = blocksOf(view);
			debug.log('Assistant message', {
				type: view.type,
				contentTypes: blocks.map((b) => b.type),
				textLength: blocks.find((b) => b.type === 'text')?.text?.length || 0,
				hasToolUse: blocks.some((b) => b.type === 'tool_use'),
			});

			// The first block only, matching the original "Track progress" logging.
			const first = blocks[0];
			if (first?.type === 'text' && first.text) {
				debug.log('Assistant response', { text: first.text.substring(0, 100) + '...' });
			} else if (first?.type === 'tool_use') {
				debug.log('Tool use', { toolName: first.name });
			}
			return;
		}

		case 'user': {
			debug.log('User message', {
				type: view.type,
				hasToolResult: blocksOf(view).some((b) => b.type === 'tool_result'),
			});
			return;
		}

		case 'result': {
			debug.log('Result message', {
				type: view.type,
				subtype: view.subtype,
				hasResult: !!view.result,
				hasError: !!view.errors?.length,
				resultLength: view.result ? String(view.result).length : 0,
				error: view.errors?.join('; ') || 'none',
				duration_ms: view.duration_ms,
				total_cost: view.total_cost_usd,
			});

			// Escalated to error level: this one usually means a real failure rather than a
			// diagnostic worth ignoring.
			if (view.subtype === 'error_during_execution') {
				debug.error('Claude Code execution error', {
					subtype: view.subtype,
					error: view.errors?.join('; '),
					details: JSON.stringify(view).substring(0, 500),
				});
			}
			return;
		}
	}

	debug.log('Other message', {
		type: view.type,
		message: JSON.stringify(message).substring(0, 200),
	});
}
