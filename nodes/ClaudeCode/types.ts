import type {
	EffortLevel,
	Options,
	PermissionMode,
	SDKMessage,
	SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AttachmentSpec } from './attachments/types';
import type { TerminationReason } from './timeout';

/**
 * The SDK's own option type, not a local restatement of it. The node used to carry a
 * hand-written `interface QueryOptions` listing about twenty fields, with `mcpServers` and
 * `hooks` widened to `any`; it drifted silently on every dependency bump. Deriving it means a
 * renamed or removed option fails to compile instead of being quietly dropped on the floor.
 */
export type SdkOptions = Options;

export type QueryOptions = {
	prompt: AsyncIterable<SDKUserMessage>;
	options: SdkOptions;
};

/** What the node's Effort selector offers: the SDK's levels, plus Ultracode on top. */
export type EffortSelection = EffortLevel | 'ultracode';

export type OutputFormat = 'structured' | 'messages' | 'text';

export type Operation = 'query' | 'continue';

/**
 * The Attach All Binaries selector. `auto` is resolved against the node version in params.ts,
 * because a schema default is written into every stored workflow before execution and therefore
 * cannot be made version-aware. See the comment on the parameter itself.
 */
export type AttachAllSelection = 'auto' | 'on' | 'off';

/** The Thinking selector's values. Mapped onto the SDK's `ThinkingConfig` in config.ts. */
export type ThinkingSelection = 'default' | 'disabled' | 'adaptive' | 'summarized';

/**
 * Which output shape to emit, independent of the node version.
 *
 * `auto` routes by typeVersion, which is the mechanism n8n gives for this. It exists because
 * n8n has no UI picker for a node version and a node keeps the one it was created with, so an
 * older node otherwise cannot reach the unified shape without being deleted and re-added.
 */
export type OutputEnvelope = 'auto' | 'unified';

/** The `additionalOptions` collection. Every field is optional — an unset collection field
 * arrives as `undefined`, which is why version-aware defaults are applied in params.ts. */
export type AdditionalOptions = {
	systemPrompt?: string;
	permissionMode?: PermissionMode;
	debug?: boolean;
	fallbackModel?: string;
	maxThinkingTokens?: number;
	maxBudgetUsd?: number;
	includeTranscript?: boolean;
	allowPlanExecution?: boolean;
	pathToClaudeCodeExecutable?: string;
	thinking?: ThinkingSelection;
	outputEnvelope?: OutputEnvelope;
	wrapUpGraceSeconds?: number;
	inlineTextLimitKb?: number;
	maxAttachmentMb?: number;
	maxAttachmentCount?: number;
	allowedExtensions?: string[];
};

/** Everything read off the node's parameters for one input item. The only thing produced by
 * touching `IExecuteFunctions`, so every stage after params.ts is pure. */
export type ClaudeCodeParams = {
	operation: Operation;
	sessionId: string;
	prompt: string;
	model: string;
	effort: EffortSelection;
	maxTurns: number;
	timeoutSeconds: number;
	projectPath: string;
	outputFormat: OutputFormat;
	allowedTools: string[];
	disallowedTools: string[];
	restrictTools: string[];
	/** Which binary properties to send and under what limits. Resolved in params.ts so every
	 * consumer takes one plain value rather than five. */
	attachments: AttachmentSpec;
	additional: AdditionalOptions;
	nodeVersion: number;
	itemIndex: number;
};

/**
 * What one run produced. A timeout is reported here rather than thrown, so the run loop has a
 * single exit and the node decides whether it becomes an error item or an exception.
 */
export type RunOutcome = {
	messages: SDKMessage[];
	timedOut: boolean;
	terminationReason: TerminationReason | null;
	/** A graceful stop asks Claude to summarise. That turn can itself run out of time, in which
	 * case the metrics survive but the summary does not. */
	wrapUpSucceeded: boolean;
	durationMs: number;
	/** The effort Claude Code actually applied, post-downgrade. Exposed only inside hooks, never
	 * in the message stream. Null when no hook fired. */
	appliedEffort: string | null;
	/** Set when the generator itself rejected. The SDK delivers the result message before
	 * rejecting, so `messages` may still hold the spend and session data. */
	error: unknown;
};
