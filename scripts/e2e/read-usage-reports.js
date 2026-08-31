// Runs INSIDE the container. Prints the payloads the usage collector received since a given
// epoch-ms timestamp, as JSON.
//
// A sub-node's usage report leaves the calling workflow entirely — executeWorkflow starts a
// separate execution — so no amount of digging in the caller's run data can show it. The
// collector's own execution record is the evidence, and this is how the verdict reaches it.
const { DatabaseSync } = require('node:sqlite');
const flatted = require('/usr/local/lib/node_modules/n8n/node_modules/flatted');

const since = Number(process.argv[2] ?? 0);
const db = new DatabaseSync('/home/node/.n8n/database.sqlite', { readOnly: true });

// By id, not by name: the collector is deliberately NOT named `case*` (run-cases would execute
// it as a case), so a name match is the wrong handle.
const COLLECTOR_ID = 'case71collector0';
const wf = db.prepare('SELECT id FROM workflow_entity WHERE id = ?').get(COLLECTOR_ID);
if (!wf) {
	console.log('[]');
	process.exit(0);
}

const rows = db
	.prepare('SELECT id, startedAt FROM execution_entity WHERE workflowId = ? ORDER BY id DESC LIMIT 20')
	.all(COLLECTOR_ID);

const reports = [];
for (const row of rows) {
	if (since && new Date(row.startedAt).getTime() < since - 5000) continue;
	const data = db.prepare('SELECT data FROM execution_data WHERE executionId = ?').get(row.id);
	if (!data) continue;
	try {
		const parsed = flatted.parse(data.data);
		const runData = parsed?.resultData?.runData ?? {};
		for (const runs of Object.values(runData)) {
			const json = runs?.[0]?.data?.main?.[0]?.[0]?.json;
			if (json && json.run_key) reports.push(json);
		}
	} catch {
		// A collector execution we cannot read is not a report we can assert on.
	}
}

console.log(JSON.stringify(reports));
