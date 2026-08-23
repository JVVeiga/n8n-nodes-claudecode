import type { IDataObject } from 'n8n-workflow';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildLegacyOutput } from './legacy';
import { buildV12Output } from './v12';
import type { OutputFormat } from '../types';

/**
 * The one entry point for shaping a successful run into an n8n item.
 *
 * Versions 1 and 1.1 route to the frozen builders in legacy.ts; 1.2 and above route to the unified
 * envelope in v12.ts. Two implementations rather than one parameterised builder, on purpose: the
 * old shapes are frozen by 48 golden fixtures, and pretending one builder could produce both would
 * put that frozen behaviour at risk on every future edit to the new one.
 *
 * `>=` rather than `===` so a future 1.3 inherits the envelope instead of silently falling back to
 * the legacy shapes.
 */

export type OutputInput = {
	nodeVersion: number;
	format: OutputFormat;
	messages: SDKMessage[];
	diagnostics: Record<string, unknown> | null;
	includeTranscript: boolean;
	/** Wall time from the runner. Only 1.2+ uses it, as a fallback when the SDK reported none. */
	durationMs?: number;
};

/** Below this, the legacy shapes. At or above it, the unified envelope. */
export const UNIFIED_ENVELOPE_FROM = 1.2;

export function buildOutputItem(input: OutputInput): IDataObject {
	if (input.nodeVersion >= UNIFIED_ENVELOPE_FROM) {
		return buildV12Output({
			format: input.format,
			messages: input.messages,
			diagnostics: input.diagnostics,
			includeTranscript: input.includeTranscript,
			durationMs: input.durationMs ?? 0,
		});
	}

	return buildLegacyOutput({
		format: input.format,
		messages: input.messages,
		diagnostics: input.diagnostics,
		includeTranscript: input.includeTranscript,
	});
}
