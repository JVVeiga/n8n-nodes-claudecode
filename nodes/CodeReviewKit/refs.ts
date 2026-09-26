import type { Problem } from '../shared/problem';

const SAFE_REF = /^[\w./@^~-]+$/;

export const isSafeRef = (ref: string): boolean => SAFE_REF.test(ref) && !ref.startsWith('-');

/** Checked before git runs: a ref starting with `-` would be read as an option. */
export function checkRef(ref: string, label: string): Problem | null {
	if (ref === '') {
		return {
			message: `${label} is empty`,
			description: 'Give a branch, tag or commit SHA, e.g. origin/main, v1.2.0 or HEAD~1.',
		};
	}
	if (isSafeRef(ref)) return null;
	return {
		message: `${label} is not an accepted git ref: ${JSON.stringify(ref)}`,
		description:
			'Use a branch, tag, commit SHA or a relative ref like HEAD~1 — letters, digits and . / _ @ ^ ~ - only, not starting with "-". Spaces, colons and shell characters are refused before git runs.',
	};
}
