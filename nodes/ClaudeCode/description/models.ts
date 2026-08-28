import type { INodePropertyOptions } from 'n8n-workflow';

/**
 * The one model list.
 *
 * There used to be two: the Model selector offered nine models, and the Fallback Model selector
 * offered seven of them. Opus 4.7 and Fable 5 could be chosen as the primary model but not as a
 * fallback — nobody decided that, the lists just drifted. Generating both selectors from one array
 * makes that class of drift impossible.
 *
 * Order is deliberate and NOT alphabetical: aliases first, then pinned IDs newest-first. The n8n
 * lint rule that wants alphabetical options is disabled at each call site for that reason.
 */

export type ModelChoice = {
	name: string;
	value: string;
	/** Shown in the Model selector — what the model is good for. */
	description: string;
	/** Used to build the Fallback Model selector's description, which reads "Fallback to X". */
	short: string;
};

export const MODELS: ModelChoice[] = [
	{
		name: 'Sonnet (Latest Alias)',
		value: 'sonnet',
		description: 'Auto-resolves to the latest Sonnet — balanced speed and intelligence',
		short: 'latest Sonnet',
	},
	{
		name: 'Opus (Latest Alias)',
		value: 'opus',
		description: 'Auto-resolves to the latest Opus — most capable for complex tasks',
		short: 'latest Opus',
	},
	{
		name: 'Haiku (Latest Alias)',
		value: 'haiku',
		description: 'Auto-resolves to the latest Haiku — fastest and most cost-effective',
		short: 'latest Haiku',
	},
	{
		name: 'Opus 5',
		value: 'claude-opus-5',
		description: 'Latest and most capable Opus model',
		short: 'Opus 5',
	},
	{
		name: 'Opus 4.8',
		value: 'claude-opus-4-8',
		description: 'Previous-generation Opus, state-of-the-art agentic work',
		short: 'Opus 4.8',
	},
	{
		name: 'Opus 4.7',
		value: 'claude-opus-4-7',
		description: 'Previous-generation Opus, highly autonomous',
		short: 'Opus 4.7',
	},
	{
		name: 'Sonnet 5',
		value: 'claude-sonnet-5',
		description: 'Near-Opus quality on coding/agentic work at Sonnet cost',
		short: 'Sonnet 5',
	},
	{
		name: 'Haiku 4.5',
		value: 'claude-haiku-4-5',
		description: 'Fast and cost-effective for simpler tasks',
		short: 'Haiku 4.5',
	},
	{
		name: 'Fable 5',
		value: 'claude-fable-5',
		description: 'Anthropic’s most capable model for demanding long-horizon work',
		short: 'Fable 5',
	},
];

export const MODEL_OPTIONS: INodePropertyOptions[] = MODELS.map(({ name, value, description }) => ({
	name,
	value,
	description,
}));

/** None first — it is the default, and the absence of a fallback is the common case. */
export const FALLBACK_MODEL_OPTIONS: INodePropertyOptions[] = [
	{ name: 'None', value: '', description: 'No fallback model' },
	...MODELS.map(({ name, value, short }) => ({
		name,
		value,
		description: `Fallback to ${short}`,
	})),
];
