import type { INodeProperties, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionType } from 'n8n-workflow';

const on = (...operation: string[]) => ({ show: { operation } });

const fieldName = (
	displayName: string,
	name: string,
	defaultValue: string,
	description: string,
	operations: string[],
): INodeProperties => ({
	displayName,
	name,
	type: 'string',
	default: defaultValue,
	description,
	displayOptions: on(...operations),
});

export const codeReviewKitDescription: INodeTypeDescription = {
	displayName: 'Code Review Kit',
	name: 'codeReviewKit',
	icon: 'file:codereviewkit.svg',
	group: ['transform'],
	version: 1,
	subtitle:
		'={{ { dedupe: "Dedupe", diffContext: "Diff Context", fingerprint: "Fingerprint", validateAnchors: "Validate Anchors" }[$parameter["operation"]] }}',
	description:
		'Deterministic helpers for a review bot: read a git diff, check comment anchors, fingerprint and dedupe findings. Runs git, never a model.',
	defaults: {
		name: 'Code Review Kit',
	},
	inputs: [{ type: NodeConnectionType.Main }],
	outputs: [{ type: NodeConnectionType.Main }],
	properties: [
		{
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			options: [
				{
					name: 'Dedupe',
					value: 'dedupe',
					description:
						'Split findings into new, repeated and resolved against a previous run, by fingerprint',
					action: 'Dedupe findings against a previous run',
				},
				{
					name: 'Diff Context',
					value: 'diffContext',
					description:
						'Changed files, the added line numbers per file and, optionally, the patch between two refs',
					action: 'Read the diff between two refs',
				},
				{
					name: 'Fingerprint',
					value: 'fingerprint',
					description:
						'Add a stable hash of path, type and the code around the line, read at a ref',
					action: 'Fingerprint findings',
				},
				{
					name: 'Validate Anchors',
					value: 'validateAnchors',
					description:
						'Keep findings that sit on an added line; move the rest aside with the reason',
					action: 'Validate finding anchors against the diff',
				},
			],
			default: 'diffContext',
		},
		{
			displayName: 'Project Path',
			name: 'projectPath',
			type: 'string',
			default: '',
			required: true,
			placeholder: '/workspace/my-repo',
			description: 'The git clone to read. git runs here; nothing in it is modified.',
			hint: 'The path must exist inside the n8n container',
			displayOptions: on('diffContext', 'fingerprint'),
		},
		{
			displayName: 'Base Ref',
			name: 'baseRef',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'origin/main',
			description:
				'The branch, tag or SHA the change is going into. The diff starts at its merge base with Head Ref, as a pull request does.',
			displayOptions: on('diffContext'),
		},
		{
			displayName: 'Head Ref',
			name: 'headRef',
			type: 'string',
			default: 'HEAD',
			description: 'The branch, tag or SHA holding the change',
			displayOptions: on('diffContext'),
		},
		{
			displayName: 'Include Patch',
			name: 'includePatch',
			type: 'boolean',
			default: false,
			description:
				'Whether to add the zero-context patch (git diff -U0) as text, for a model to read',
			displayOptions: on('diffContext'),
		},
		{
			displayName: 'Max Patch Characters',
			name: 'maxPatchChars',
			type: 'number',
			default: 100000,
			typeOptions: { minValue: 0 },
			description:
				'Cut the patch at a line break before this many characters and mark it truncated. 0 means no cap.',
			displayOptions: { show: { operation: ['diffContext'], includePatch: [true] } },
		},
		{
			displayName: 'Ref',
			name: 'ref',
			type: 'string',
			default: 'HEAD',
			description:
				'The branch, tag or SHA whose files the snippets are read from — normally the head of the change',
			displayOptions: on('fingerprint'),
		},
		{
			displayName: 'Items',
			name: 'items',
			type: 'json',
			default: '[]',
			description:
				'A JSON array of findings, usually an expression. Each needs a path and a line; other fields pass through.',
			hint: 'e.g. {{ $json.findings }}',
			displayOptions: on('validateAnchors', 'fingerprint'),
		},
		{
			displayName: 'Added Lines',
			name: 'addedLines',
			type: 'json',
			default: '{}',
			description:
				'The addedLines object from Diff Context, mapping each file to its added line numbers: { "src/a.ts": [3, 4] }',
			hint: 'e.g. {{ $json.addedLines }}',
			displayOptions: on('validateAnchors'),
		},
		{
			displayName: 'New Items',
			name: 'newItems',
			type: 'json',
			default: '[]',
			description: 'This run’s findings, each carrying a fingerprint',
			displayOptions: on('dedupe'),
		},
		{
			displayName: 'Previous Items',
			name: 'previousItems',
			type: 'json',
			default: '[]',
			description:
				'The findings stored from earlier runs, each with a fingerprint and a status. Open ones missing from New Items come back as resolved.',
			displayOptions: on('dedupe'),
		},
		fieldName(
			'Path Field',
			'pathField',
			'path',
			'The item field holding the file path, relative to the repository root',
			['validateAnchors', 'fingerprint'],
		),
		fieldName(
			'Line Field',
			'lineField',
			'line',
			'The item field holding the line number in the new version of the file',
			['validateAnchors', 'fingerprint'],
		),
		fieldName('Type Field', 'typeField', 'type', 'The item field holding the finding type', [
			'fingerprint',
		]),
		{
			displayName: 'Context Lines',
			name: 'contextLines',
			type: 'number',
			default: 2,
			typeOptions: { minValue: 0 },
			description:
				'Lines above and below the anchor that go into the fingerprint. More lines tell similar findings apart; fewer survive nearby edits.',
			displayOptions: on('fingerprint'),
		},
		fieldName(
			'Fingerprint Field',
			'fingerprintField',
			'fingerprint',
			'The item field the fingerprint is written to, and read from when deduping',
			['fingerprint', 'dedupe'],
		),
		fieldName(
			'Status Field',
			'statusField',
			'status',
			'The previous item field holding its status',
			['dedupe'],
		),
		fieldName(
			'Open Value',
			'openValue',
			'open',
			'The status value that marks a previous finding as still open',
			['dedupe'],
		),
	],
};
