// Runs INSIDE the container. Writes a session id into the case08 workflow's Claude Code node.
//
// case08 resumes the session that case01 started, so its sessionId cannot be known when the
// workflows are generated. The generator writes the literal PASTE_SESSION_ID_FROM_CASE01 and this
// patches it — previously a manual step, which is why case08 failed the moment the rig was run
// unattended: the CLI got the placeholder and rejected it with "--resume requires a valid session
// ID or session title".
//
// Usage: node /tmp/patch-session.js <sessionId>
const { DatabaseSync } = require('node:sqlite');

const sessionId = process.argv[2];
if (!sessionId || sessionId === 'PASTE_SESSION_ID_FROM_CASE01') {
	console.error('usage: node patch-session.js <sessionId>  (a real session id)');
	process.exit(2);
}

const db = new DatabaseSync('/home/node/.n8n/database.sqlite');
const row = db.prepare("SELECT id, name, nodes FROM workflow_entity WHERE name LIKE 'case08%'").get();
if (!row) {
	console.error('no case08 workflow found — import the workflows first');
	process.exit(1);
}

const nodes = JSON.parse(row.nodes);
const claude = nodes.find((n) => String(n.type).includes('claudeCode'));
if (!claude) {
	console.error('case08 has no Claude Code node');
	process.exit(1);
}

const previous = claude.parameters.sessionId;
claude.parameters.sessionId = sessionId;
db.prepare('UPDATE workflow_entity SET nodes = ? WHERE id = ?').run(JSON.stringify(nodes), row.id);
console.log(JSON.stringify({ workflow: row.name, from: previous, to: sessionId }));
