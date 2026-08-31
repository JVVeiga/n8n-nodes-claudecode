import type { IExecuteFunctions } from 'n8n-workflow';
import type { Problem } from './problem';
import { checkAuthSecret, CREDENTIAL_FOR_MODE, type AuthMode, type AuthSelection } from './auth';

/**
 * The two members this module actually touches, named structurally so both `IExecuteFunctions`
 * and `ISupplyDataFunctions` fit. The Chat Model node reads auth from `supplyData`, whose context
 * is not an `IExecuteFunctions` — and demanding one here would be a lie about what is used.
 */
export type AuthReadContext = {
	getNodeParameter: IExecuteFunctions['getNodeParameter'];
	getCredentials: IExecuteFunctions['getCredentials'];
};

/**
 * The impure half of authentication: reading the selector and the credential off n8n.
 *
 * It is its own module rather than part of `params.ts` for three reasons. `readParams` is
 * synchronous and everything downstream depends on that, while `getCredentials()` returns a
 * promise. Both nodes need this, and the Usage node has no `params.ts`. And the result reaches
 * `config.ts` the way `stagedDir` already does — through `deps`, as a runtime fact rather than a
 * parameter.
 */

export type AuthOutcome = { auth: AuthSelection } | { problem: Problem };

const SECRET_FIELD = {
	apiKey: 'apiKey',
	oauthToken: 'oauthToken',
} as const;

/**
 * `authSource` defaults to `host`, which is what a workflow stored before this feature existed
 * reads as — and host mode is byte-for-byte the behaviour it already had.
 */
export async function readAuth(ctx: AuthReadContext, itemIndex: number): Promise<AuthOutcome> {
	const mode = ctx.getNodeParameter('authSource', itemIndex, 'host') as AuthMode;
	if (mode !== 'apiKey' && mode !== 'oauthToken') return { auth: { mode: 'host' } };

	const credentialName = CREDENTIAL_FOR_MODE[mode];
	let raw: unknown;
	try {
		raw = await ctx.getCredentials(credentialName, itemIndex);
	} catch {
		// n8n throws when no credential is selected. Reported as a Problem so the node turns it
		// into an error where it already has the node context, same as every other validator here.
		return {
			problem: {
				message: `No credential selected for Authentication: ${mode === 'apiKey' ? 'API Key' : 'OAuth Token'}`,
				description:
					'Pick or create a credential on this node, or set Authentication to Host to use the account the n8n container is logged in as.',
			},
		};
	}

	const value = (raw as Record<string, unknown> | undefined)?.[SECRET_FIELD[mode]];
	const secret = typeof value === 'string' ? value : '';
	const problem = checkAuthSecret(mode, secret);
	if (problem) return { problem };

	return { auth: { mode, secret: secret.trim() } };
}
