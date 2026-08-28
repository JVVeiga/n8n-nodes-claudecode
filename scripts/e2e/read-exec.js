// Runs INSIDE the container. Reads one execution's stored run data straight out of the sqlite DB
// and prints it as JSON.
//
// Needed because `n8n execute --id` cannot report an execution that finishes almost instantly: the
// CLI's post-execute promise loses the record and it dies with "No active execution found" from
// ActiveExecutions.getExecutionOrFail, before printing anything. case07d hits that — an empty
// prompt makes the node throw in ~0.4s. The execution itself completes and is stored correctly, so
// the DB is the honest source.
//
// Usage: node /tmp/read-exec.js <workflowId>   (reads that workflow's most recent execution)
const { DatabaseSync } = require('node:sqlite');

const workflowId = process.argv[2];
if (!workflowId) {
	console.error('usage: node read-exec.js <workflowId>');
	process.exit(2);
}

const db = new DatabaseSync('/home/node/.n8n/database.sqlite', { readOnly: true });
const execution = db
	.prepare(
		'SELECT id, status, workflowId, startedAt, stoppedAt FROM execution_entity ' +
			'WHERE workflowId = ? ORDER BY id DESC LIMIT 1',
	)
	.get(workflowId);

if (!execution) {
	console.log(JSON.stringify({ found: false }));
	process.exit(0);
}

const row = db.prepare('SELECT data FROM execution_data WHERE executionId = ?').get(execution.id);

// n8n serialises run data with `flatted`, not JSON.stringify: the column holds an array where the
// first element is the root and every nested object is a numeric-string reference into the same
// array. flatted.parse reverses it. n8n ships the package, so use n8n's own copy rather than
// reimplementing the format and getting the cycles wrong.
let rehydrated = null;
let rehydrateError = null;
if (row && row.data) {
	try {
		// eslint-disable-next-line
		const flatted = require('/usr/local/lib/node_modules/n8n/node_modules/flatted');
		rehydrated = flatted.parse(row.data);
	} catch (error) {
		rehydrateError = error.message;
	}
}

console.log(
	JSON.stringify({
		found: true,
		id: execution.id,
		status: execution.status,
		startedAt: execution.startedAt,
		stoppedAt: execution.stoppedAt,
		// The same shape `n8n execute` prints, so the caller can treat both sources identically.
		data: rehydrated,
		rehydrateError,
		raw: rehydrated ? null : (row ? row.data : null),
	}),
);
