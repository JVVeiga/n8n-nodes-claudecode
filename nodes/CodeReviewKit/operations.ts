import type { IDataObject } from 'n8n-workflow';
import type { Problem } from '../shared/problem';
import { checkProjectPath } from '../shared/projectPath';
import { validateAnchors } from './anchors';
import { dedupe } from './dedupe';
import { completeAddedLines, parseAddedLines, parseNumstat, truncatePatch } from './diff';
import { fingerprintItems } from './fingerprint';
import type { GitApi } from './git';
import { parseAddedLinesParam, parseItemsParam } from './input';
import type { KitParams } from './params';
import { checkRef } from './refs';

export type KitDeps = { git: (projectPath: string) => GitApi };

export type KitOutcome = { json: IDataObject } | { problem: Problem };

const requireProjectPath = (projectPath: string, operation: string): Problem | null =>
	projectPath === ''
		? {
				message: `${operation} needs a Project Path`,
				description:
					'Point Project Path at the git clone to read, e.g. /workspace/my-repo. If n8n runs in Docker, the clone must be mounted into the container.',
			}
		: checkProjectPath(projectPath);

type DiffParams = Extract<KitParams, { operation: 'diffContext' }>;
type FingerprintParams = Extract<KitParams, { operation: 'fingerprint' }>;

async function diffContext(params: DiffParams, deps: KitDeps): Promise<KitOutcome> {
	const invalid =
		requireProjectPath(params.projectPath, 'Diff Context') ??
		checkRef(params.baseRef, 'Base Ref') ??
		checkRef(params.headRef, 'Head Ref');
	if (invalid) return { problem: invalid };

	const git = deps.git(params.projectPath);
	const base = await git.mergeBase(params.baseRef, params.headRef);
	if ('problem' in base) return base;
	const numstat = await git.numstat(base.ok, params.headRef);
	if ('problem' in numstat) return numstat;
	const patch = await git.patchU0(base.ok, params.headRef);
	if ('problem' in patch) return patch;

	const files = parseNumstat(numstat.ok);
	const json: IDataObject = {
		mergeBase: base.ok,
		files,
		addedLines: completeAddedLines(files, parseAddedLines(patch.ok)),
	};
	if (params.includePatch) {
		const truncated = truncatePatch(patch.ok, params.maxPatchChars);
		json.patch = truncated.text;
		json.patchTruncated = truncated.truncated;
	}
	return { json };
}

async function fingerprintOperation(params: FingerprintParams, deps: KitDeps): Promise<KitOutcome> {
	const invalid =
		requireProjectPath(params.projectPath, 'Fingerprint') ?? checkRef(params.ref, 'Ref');
	if (invalid) return { problem: invalid };
	const items = parseItemsParam(params.items, 'Items');
	if ('problem' in items) return items;

	const git = deps.git(params.projectPath);
	// A path missing at the ref is that item's problem; git itself failing is the whole run's.
	const failed: { problem: Problem | null } = { problem: null };
	const out = await fingerprintItems(
		items.value,
		params.fields,
		params.contextLines,
		async (path) => {
			const read = await git.showFile(params.ref, path);
			if ('ok' in read) return { text: read.ok };
			if (!read.missing) failed.problem ??= read.problem;
			return { error: read.problem.message };
		},
	);
	if (failed.problem) return { problem: failed.problem };
	return { json: { items: out as IDataObject[] } };
}

export async function runOperation(params: KitParams, deps: KitDeps): Promise<KitOutcome> {
	switch (params.operation) {
		case 'diffContext':
			return diffContext(params, deps);
		case 'fingerprint':
			return fingerprintOperation(params, deps);
		case 'validateAnchors': {
			const items = parseItemsParam(params.items, 'Items');
			if ('problem' in items) return items;
			const added = parseAddedLinesParam(params.addedLines);
			if ('problem' in added) return added;
			const { valid, moved } = validateAnchors(items.value, added.value, params.fields);
			return { json: { valid: valid as IDataObject[], moved: moved as IDataObject[] } };
		}
		case 'dedupe': {
			const fresh = parseItemsParam(params.newItems, 'New Items');
			if ('problem' in fresh) return fresh;
			const previous = parseItemsParam(params.previousItems, 'Previous Items');
			if ('problem' in previous) return previous;
			const result = dedupe(fresh.value, previous.value, params.fields);
			return { json: result as unknown as IDataObject };
		}
	}
}
