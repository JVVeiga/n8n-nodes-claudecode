/**
 * Truncation for text that goes into a log or an error message.
 *
 * It lived twice — once in the Chat Model, once in the Task Tool — with limits that had already
 * drifted apart (500 vs 800) for no reason anyone had decided. The limit is a parameter now, so
 * a caller that wants a different one states it.
 */
export const preview = (text: string, limit = 500): string =>
	text.length > limit ? `${text.slice(0, limit)}…` : text;
