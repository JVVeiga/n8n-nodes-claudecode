const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/home/node/.n8n/database.sqlite', { readOnly: true });
const rows = db.prepare('SELECT id, name, nodes FROM workflow_entity ORDER BY name').all();
console.log(`workflows: ${rows.length}`);
for (const r of rows) {
  const cc = JSON.parse(r.nodes).find((n) => String(n.type).includes('claudeCode'));
  const bits = cc
    ? `tv=${cc.typeVersion} timeout=${cc.parameters.timeout} grace=${cc.parameters.additionalOptions?.wrapUpGraceSeconds ?? '(unset)'} fmt=${cc.parameters.outputFormat} onError=${cc.onError ?? 'stopWorkflow'}`
    : 'no claude node';
  console.log(`  ${r.name}\n      ${bits}`);
}
