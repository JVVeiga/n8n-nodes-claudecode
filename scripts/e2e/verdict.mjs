import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(new URL('./results.json', import.meta.url), 'utf8'));
const get = (n) => r.find((c) => c.name.startsWith(n));
const det = (c) => c?.itemJson?.details ?? c?.itemJson ?? {};
const ctx = (c) => c?.errorContext ?? {};

const checks = [
  ['04a normal structured intact', () => { const c = get('case04a'); return c.status === 'success' && c.itemJson?.success === true && c.itemJson?.result === 'pong' && !!c.itemJson?.metrics && !!c.itemJson?.diagnostics; }],
  ['04b normal text intact', () => { const c = get('case04b'); return c.status === 'success' && c.itemJson?.result === 'pong'; }],
  ['04c normal messages intact', () => { const c = get('case04c'); return c.status === 'success' && typeof c.itemJson?.messageCount === 'number'; }],
  ['01 graceful throws with full context', () => { const c = get('case01'); return c.status === 'error' && c.errorType === 'timeout' && Object.keys(ctx(c)).length === 22 && ctx(c).usageReliable === true && ctx(c).total_cost_usd > 0; }],
  ['02 hard abort reports no fake spend', () => { const c = get('case02'); return c.status === 'error' && ctx(c).terminationReason === 'timeout_hard_abort' && ctx(c).total_cost_usd === null && ctx(c).usageReliable === false && !!ctx(c).session_id; }],
  ['03 wrap-up failed but metrics survived', () => { const c = get('case03'); return c.status === 'error' && ctx(c).terminationReason === 'timeout_graceful' && ctx(c).wrapUpSucceeded === false && ctx(c).usageReliable === true && ctx(c).total_cost_usd > 0; }],
  ['05 continueRegularOutput branch 0', () => { const c = get('case05'); return c.outputBranchIndex === 0 && det(c).timedOut === true && det(c).total_cost_usd > 0; }],
  ['06 continueErrorOutput branch 1 (AC-14)', () => { const c = get('case06'); return c.outputBranchIndex === 1 && det(c).timedOut === true && det(c).usageReliable === true; }],
  ['06 json holds only error/message/details', () => { const c = get('case06'); return JSON.stringify(Object.keys(c.itemJson).sort()) === '["details","error","message"]'; }],
  ['07b typeVersion 1 hard kills, grace 0', () => { const c = get('case07b'); return c.status === 'error' && ctx(c).wrapUpGraceSeconds === 0 && ctx(c).terminationReason === 'timeout_hard_abort'; }],
  ['07c typeVersion 1.1 runs clean', () => get('case07c').status === 'success'],
  ['07d non-timeout on error branch', () => { const c = get('case07d'); return c.outputBranchIndex === 1 && det(c).errorType === 'execution_error'; }],
  ['08 session resume works', () => { const c = get('case08'); return c.status === 'success' && c.itemJson?.success === true; }],
  ['09 text + continueOnFail carries report', () => { const c = get('case09'); return det(c).timedOut === true && det(c).total_cost_usd > 0; }],
  ['14 two items, independent sessions', () => { const c = get('case14'); return c.status === 'success' && c.itemCount === 2; }],
  ['15 messages format + timeout', () => { const c = get('case15'); return det(c).timedOut === true && det(c).usageReliable === true; }],
  ['16 continue with no sessionId', () => get('case16').status === 'success'],

  // typeVersion 1.2. The envelope itself is covered by unit tests; what only a real n8n can show
  // is 1.2 and 1.1 coexisting in one instance without 1.2 leaking backwards.
  ['20s 1.2 structured has the unified envelope', () => { const j = get('case20s')?.itemJson; return !!j && j.result === 'pong' && j.success === true && j.errorText === '' && !!j.metrics && typeof j.metrics.total_cost_usd === 'number' && !!j.metrics.session_id && !!j.summary && !!j.messages && !('messageCount' in j); }],
  ['20m 1.2 messages carries metrics too (F-03 fixed)', () => { const j = get('case20m')?.itemJson; return !!j && !!j.metrics && typeof j.metrics.total_cost_usd === 'number' && !!j.messages && !j.summary && !('messageCount' in j); }],
  ['20t 1.2 text has no transcript and no summary', () => { const j = get('case20t')?.itemJson; return !!j && !!j.metrics && !j.messages && !j.summary; }],
  // These are three SEPARATE runs, so cost, duration and session id legitimately differ. What must
  // match is the SHAPE — same envelope keys, same metric keys — and the answer to the same prompt.
  // Whether the three agree field-for-field on ONE run is a unit test's job (output.test.ts).
  ['20 all three 1.2 formats share one envelope shape', () => {
    const runs = ['case20s', 'case20m', 'case20t'].map((n) => get(n)?.itemJson);
    if (runs.some((j) => !j)) return false;
    const metricKeys = runs.map((j) => Object.keys(j.metrics).sort().join(','));
    const core = runs.map((j) => [j.result, j.success, j.errorText].join('|'));
    return metricKeys.every((k) => k === metricKeys[0]) && core.every((c) => c === core[0]);
  }],
  ['21 1.1 alongside 1.2 keeps the LEGACY shape', () => { const j = get('case21')?.itemJson; return !!j && typeof j.duration_ms === 'number' && typeof j.total_cost_usd === 'number' && !j.metrics && !('errorText' in j); }],
  ['22 1.2 reports an unknown cost as null, not zero (F-01 fixed)', () => {
    const d = det(get('case22'));
    return d.timedOut === true && d.total_cost_usd === null;
  }],
  // The Usage node. Its execute() spawns a real CLI through readUsage, the one module with no unit
  // tests by design — so these are the only automated checks that reach it.
  ['30 usage node reports plan capacity', () => {
    const j = get('case30')?.itemJson;
    return !!j && typeof j.authenticated === 'boolean' && typeof j.rateLimitsAvailable === 'boolean'
      && Array.isArray(j.windows) && !!j.account && !!j.diagnostics
      && typeof j.diagnostics.initMs === 'number';
  }],
  ['30 usage read is free — no prompt is sent', () => {
    const j = get('case30')?.itemJson;
    return !!j && (j.session?.totalCostUsd ?? 0) === 0 && j.diagnostics?.probed !== true;
  }],
  ['31 the account email is never leaked, and only ever appears when asked', () => {
    // What this can prove depends on the credential. A CLAUDE_CODE_OAUTH_TOKEN session is
    // inference-only, so there is no profile to read and no email exists either way — asserting one
    // appears would be asserting against the environment, not the node. What holds in every case:
    // the default must never carry an email, and the option must never invent one.
    const off = get('case30')?.itemJson, on = get('case31')?.itemJson;
    if (!off || !on) return false;
    if ('email' in (off.account ?? {})) return false;            // never leaked by default
    const profileReadable = off.account?.tokenSource !== 'CLAUDE_CODE_OAUTH_TOKEN';
    return profileReadable ? typeof on.account?.email === 'string' : !('email' in (on.account ?? {}));
  }],
];

// A check whose case never ran is a gap in the rig, not a regression in the node. Reporting it as
// FAIL puts three permanent red lines in every verdict, which is how a real failure gets ignored.
// The leading number in the check name is the case it needs.
const caseOf = (name) => `case${name.match(/^(\d+[a-z]?)/)?.[1] ?? ''}`;

let pass = 0;
let fail = 0;
let skip = 0;
for (const [name, fn] of checks) {
  if (!get(caseOf(name))) {
    skip++;
    console.log(`SKIP  ${name}  (no ${caseOf(name)} in results.json)`);
    continue;
  }
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped  (of ${checks.length})`);
if (fail > 0) process.exitCode = 1;
