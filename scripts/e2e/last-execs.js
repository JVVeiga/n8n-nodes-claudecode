const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/home/node/.n8n/database.sqlite', { readOnly: true });
const rows = db.prepare('SELECT id, workflowId, status, mode, startedAt, stoppedAt FROM execution_entity ORDER BY id DESC LIMIT 4').all();
for (const e of rows) {
  const wf = db.prepare('SELECT name FROM workflow_entity WHERE id = ?').get(e.workflowId);
  const dur = e.stoppedAt && e.startedAt ? ((new Date(e.stoppedAt) - new Date(e.startedAt)) / 1000).toFixed(1) + 's' : '?';
  console.log(`exec ${e.id} | ${e.status.padEnd(9)} | ${e.mode.padEnd(8)} | ${dur.padStart(6)} | ${wf?.name}`);
  const d = db.prepare('SELECT data FROM execution_data WHERE executionId = ?').get(e.id);
  if (!d) continue;
  const raw = d.data;
  const probes = ['timed out after', 'wrap-up', 'aborted by user', 'terminationReason', 'timeout_hard_abort', 'timeout_graceful', 'canceled'];
  const found = probes.filter((p) => raw.includes(p));
  console.log(`         markers: ${found.join(', ') || '(none)'}`);
}
