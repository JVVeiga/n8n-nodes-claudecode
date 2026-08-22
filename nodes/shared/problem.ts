/**
 * A validation failure, returned rather than thrown.
 *
 * Throwing a `NodeOperationError` needs `this.getNode()`, which would drag `IExecuteFunctions`
 * into every validator and make each one untestable without a node instance. The validators hand
 * back a Problem; the node turns it into an error where it already has the context to do so.
 */
export type Problem = {
	message: string;
	/** The fix, not a restatement of the message — this is what n8n shows under the error. */
	description: string;
};
