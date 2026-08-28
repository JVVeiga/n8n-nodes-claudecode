import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

/**
 * The plain-data vocabulary of the attachment path.
 *
 * Everything here is a value, never a handle: `collect.ts` turns n8n binary properties into
 * `Attachment[]`, `plan.ts` turns those into blocks and a staging list without touching a disk,
 * and `stage.ts` is the only module that owns anything needing cleanup. That split is what makes
 * the routing policy and the turn-building assertable.
 *
 * `ContentBlockParam` comes from `@anthropic-ai/sdk`, already present as a transitive dependency
 * of the agent SDK and the same package the agent SDK itself imports `MessageParam` from
 * (`sdk.d.ts:8`). It is a type-only import, so it adds nothing at runtime.
 */

/** What the node's five attachment parameters resolve to. Read once, in params.ts. */
export type AttachmentSpec = {
	/** Attach every binary property on the item, ignoring `names`. */
	all: boolean;
	/** The explicit property names, already split and trimmed. Ignored when `all` is true. */
	names: string[];
	/** Above this, a textual file is staged instead of inlined. The only size knob that is a real
	 * trade rather than an API limit — 256 KB of CSV is roughly 64k tokens, every turn. */
	inlineTextLimitKb: number;
	/** Hard per-file cap. Over it is a Problem, not a staging decision. */
	maxAttachmentMb: number;
	maxAttachmentCount: number;
};

/** One binary property, resolved to bytes and named. */
export type Attachment = {
	/** The n8n binary property it came from, so an error can name what the user has to fix. */
	propName: string;
	/** The derived, sanitized, item-unique filename. Used as a document title and as the on-disk
	 * name, so the model refers to the same string either way. */
	fileName: string;
	/** The MIME type as n8n reported it. May be absent or `application/octet-stream`, which is why
	 * routing also considers the extension and the bytes. */
	mimeType: string;
	bytes: number;
	buffer: Buffer;
};

/**
 * How one attachment reaches the model. A total function of (mimeType, bytes, spec) — see
 * `mime.ts`. `staged` always carries its reason, because "why was my CSV not inlined" is the
 * question the debug log and diagnostics exist to answer.
 */
export type Route =
	| { kind: 'image'; mediaType: InlineImageMediaType }
	| { kind: 'document-pdf' }
	| { kind: 'document-text' }
	| { kind: 'staged'; reason: StagedReason };

/** The only four values `Base64ImageSource.media_type` accepts. Anything else must not be sent as
 * an image block — it is a 400, not a degraded result. */
export type InlineImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export type StagedReason = 'over-inline-limit' | 'no-inline-route';

/** What `plan.ts` decided, as data. Nothing here has been written or sent yet. */
export type AttachmentPlan = {
	/** The inline blocks, in collection order. Empty when everything staged. */
	blocks: ContentBlockParam[];
	/** What the disk has to hold. Empty when everything inlined — and when it is empty the node
	 * makes no filesystem call at all. */
	toStage: Attachment[];
	/** What to report on `diagnostics.attachments`. Null when there were no attachments, which is
	 * what keeps the key absent and the golden fixtures byte-identical. */
	report: AttachmentDiagnostics | null;
	/** Per-file routing decisions, for the debug log. Collected here so no `if (debug)` branch
	 * appears in the planning logic. */
	notes: Record<string, unknown>;
};

export type InlineKind = 'image' | 'document-pdf' | 'document-text';

export type AttachmentDiagnostics = {
	count: number;
	totalBytes: number;
	inline: { name: string; mimeType: string; bytes: number; as: InlineKind }[];
	/** Null when everything went inline. */
	staged: {
		dir: string;
		files: { name: string; mimeType: string; bytes: number }[];
	} | null;
};

/** A temp directory holding the staged files, and the one thing that must always be undone. */
export type StagedAttachments = {
	/** Absolute path, handed to the SDK as `additionalDirectories`. */
	dir: string;
	/** The names actually written, in staging order. */
	fileNames: string[];
	/** Remove the directory and its contents. Idempotent — it is called from a `finally` that can
	 * run after an earlier failure already cleaned up. */
	cleanup: () => void;
};
