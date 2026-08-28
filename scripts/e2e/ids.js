const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/home/node/.n8n/database.sqlite', { readOnly: true });
for (const r of db.prepare('SELECT id, name FROM workflow_entity ORDER BY name').all()) {
  console.log(`${r.id}\t${r.name}`);
}
