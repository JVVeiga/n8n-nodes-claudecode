const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/home/node/.n8n/database.sqlite');
const p = db.prepare("SELECT id, name FROM workflow_entity WHERE name LIKE 'case10 PRODUCER%'").get();
db.prepare('UPDATE workflow_entity SET active = 1 WHERE id = ?').run(p.id);
console.log('activated:', p.name, p.id);
