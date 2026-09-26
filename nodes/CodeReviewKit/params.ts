import type { IExecuteFunctions } from 'n8n-workflow';
import type { AnchorFields } from './anchors';
import type { DedupeFields } from './dedupe';
import type { FingerprintFields } from './fingerprint';

export type KitOperation = 'dedupe' | 'diffContext' | 'fingerprint' | 'validateAnchors';

export type KitParams =
	| {
			operation: 'diffContext';
			projectPath: string;
			baseRef: string;
			headRef: string;
			includePatch: boolean;
			maxPatchChars: number;
	  }
	| {
			operation: 'validateAnchors';
			items: unknown;
			addedLines: unknown;
			fields: AnchorFields;
	  }
	| {
			operation: 'fingerprint';
			projectPath: string;
			ref: string;
			items: unknown;
			fields: FingerprintFields;
			contextLines: number;
	  }
	| {
			operation: 'dedupe';
			newItems: unknown;
			previousItems: unknown;
			fields: DedupeFields;
	  };

export type KitReadContext = Pick<IExecuteFunctions, 'getNodeParameter'>;

export function readKitParams(ctx: KitReadContext, itemIndex: number): KitParams {
	const text = (name: string, fallback: string): string =>
		String(ctx.getNodeParameter(name, itemIndex, fallback) ?? '').trim();
	// An emptied field name falls back to its default rather than reading a property named "".
	const field = (name: string, fallback: string): string => text(name, fallback) || fallback;
	const json = (name: string, fallback: string): unknown =>
		ctx.getNodeParameter(name, itemIndex, fallback);

	const operation = ctx.getNodeParameter('operation', itemIndex, 'diffContext') as KitOperation;
	switch (operation) {
		case 'validateAnchors':
			return {
				operation,
				items: json('items', '[]'),
				addedLines: json('addedLines', '{}'),
				fields: { path: field('pathField', 'path'), line: field('lineField', 'line') },
			};
		case 'fingerprint':
			return {
				operation,
				projectPath: text('projectPath', ''),
				ref: text('ref', 'HEAD'),
				items: json('items', '[]'),
				fields: {
					path: field('pathField', 'path'),
					line: field('lineField', 'line'),
					type: field('typeField', 'type'),
					fingerprint: field('fingerprintField', 'fingerprint'),
				},
				contextLines: Number(ctx.getNodeParameter('contextLines', itemIndex, 2)),
			};
		case 'dedupe':
			return {
				operation,
				newItems: json('newItems', '[]'),
				previousItems: json('previousItems', '[]'),
				fields: {
					fingerprint: field('fingerprintField', 'fingerprint'),
					status: field('statusField', 'status'),
					openValue: field('openValue', 'open'),
				},
			};
		default:
			return {
				operation: 'diffContext',
				projectPath: text('projectPath', ''),
				baseRef: text('baseRef', ''),
				headRef: text('headRef', 'HEAD'),
				includePatch: ctx.getNodeParameter('includePatch', itemIndex, false) === true,
				maxPatchChars: Number(ctx.getNodeParameter('maxPatchChars', itemIndex, 100000)),
			};
	}
}
