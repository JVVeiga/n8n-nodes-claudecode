import type { IDataObject } from 'n8n-workflow';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildLegacyOutput } from './legacy';
import type { OutputFormat } from '../types';

/**
 * The one entry point for shaping a successful run into an n8n item.
 *
 * Versions 1 and 1.1 route to the frozen builders in legacy.ts. Version 1.2 will route to the
 * unified envelope in v12.ts. Two implementations rather than one parameterised builder, on
 * purpose: R1 forbids touching the old shapes, and pretending one builder can produce both would
 * put the frozen behaviour at risk on every future 1.2 edit.
 */

export type OutputInput = {
	nodeVersion: number;
	format: OutputFormat;
	messages: SDKMessage[];
	diagnostics: Record<string, unknown> | null;
	includeTranscript: boolean;
};

/** Below this, the legacy shapes. At or above it, the unified envelope. */
export const UNIFIED_ENVELOPE_FROM = 1.2;

export function buildOutputItem(input: OutputInput): IDataObject {
	// v12.ts lands in T11; until then every version gets the legacy shapes, which is correct
	// because 1.2 is not offered by the description yet.
	return buildLegacyOutput({
		format: input.format,
		messages: input.messages,
		diagnostics: input.diagnostics,
		includeTranscript: input.includeTranscript,
	});
}
