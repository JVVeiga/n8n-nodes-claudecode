const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/home/node/.n8n/database.sqlite', { readOnly: true });
const cols = db.prepare('PRAGMA table_info(execution_entity)').all().map((c) => c.name);
const e = db.prepare('SELECT * FROM execution_entity ORDER BY id DESC LIMIT 1').get();
if (!e) { console.log('no executions recorded'); process.exit(0); }
console.log('execution', e.id, '| status:', e.status, '| workflowId:', e.workflowId, '| started:', e.startedAt, '| stopped:', e.stoppedAt);
const d = db.prepare('SELECT data FROM execution_data WHERE executionId = ?').get(e.id);
if (!d) { console.log('(no execution_data row)'); process.exit(0); }
const raw = d.data;
// n8n stores this flattened; just surface the interesting fragments rather than rehydrating it.
const pick = (re, n = 1) => { const m = raw.match(re); return m ? m.slice(1, 1 + n) : null; };
console.log('\n--- searching the stored run data ---');
for (const needle of ['Not logged in', 'timedOut', 'errorType', 'total_cost_usd', 'usageReliable', 'session_id', 'apiKeySource', 'resolvedModel', '"success"']) {
  const i = raw.indexOf(needle);
  console.log(`${needle.padEnd(18)} ${i === -1 ? 'absent' : 'at ' + i}`);
}
const err = pick(/"message":"([^"]{0,240})"/);
if (err) console.log('\nfirst message field:', err[0]);
console.log('\ndata length:', raw.length, 'chars');
