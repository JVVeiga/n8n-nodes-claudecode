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
  // Attachments. These are the only checks that prove a file reaches the model at all — the unit
  // tests prove which blocks get built, not that the API and CLI accept them.
  ['40 an image reaches the model directly, with no tool involved', () => {
    const j = get('case40')?.itemJson;
    if (!j || j.success !== true) return false;
    const a = j.diagnostics?.attachments;
    // The answer has to come from the pixels: nothing in the prompt says what colour it is.
    return /green/i.test(String(j.result)) && !/NO_IMAGE/.test(String(j.result))
      && a?.count === 1 && a.staged === null && a.inline?.[0]?.as === 'image';
  }],
  ['41 a csv reaches the model as a document block', () => {
    const j = get('case41')?.itemJson;
    if (!j || j.success !== true) return false;
    const a = j.diagnostics?.attachments;
    // 412 exists nowhere but in the attached bytes.
    return /412/.test(String(j.result)) && a?.inline?.[0]?.as === 'document-text' && a.staged === null;
  }],
  ['42 an oversized file is staged, and the agent reads it off disk', () => {
    const j = get('case42')?.itemJson;
    if (!j || j.success !== true) return false;
    const a = j.diagnostics?.attachments;
    // 8823 is on the LAST row, so the hint block alone cannot produce it — this is what proves
    // additionalDirectories worked and the temp dir was reachable from inside the container.
    return /8823/.test(String(j.result))
      && a?.inline?.length === 0
      && typeof a.staged?.dir === 'string' && a.staged.dir.length > 0
      && a.staged.files?.[0]?.name === 'dump.csv';
  }],
  ['43 a missing binary property fails the item on the error branch, naming it', () => {
    const c = get('case43');
    if (!c) return false;
    const j = c.itemJson ?? {};
    // The message has to name the property, so the fix is obvious from the item alone.
    //
    // It does NOT also assert the Problem's description ("the item carries these binary
    // properties: data"). That description reaches a THROWN NodeOperationError but not a soft
    // failure item: buildFailureItem passes null as the description, and shapeFailureJson then
    // sets `message` to the message rather than the fix. Asserting it here failed on the first
    // real run — the node was right and the check was wrong. Logged as a 1.3 candidate rather
    // than patched, because giving buildFailureItem a description changes `message` on every
    // existing 1.1 failure item.
    return /no binary property named "screenshot"/.test(String(j.error ?? j.message))
      && String(det(c).errorType) === 'execution_error';
  }],
  ['43 a rejected attachment costs nothing — the agent never ran', () => {
    const d = det(get('case43'));
    // No session, no turns: collectAttachments fails before query() is called.
    return (d.total_cost_usd ?? 0) === 0 && !d.session_id;
  }],
  ['44 attach-all sends several files, in property-name order', () => {
    const a = get('case44')?.itemJson?.diagnostics?.attachments;
    if (!a || a.count !== 3) return false;
    // Sorted by property name (a_shot, b_small, c_big), not by item key order — the guarantee is
    // that the model sees the same sequence on every run over the same data.
    return a.inline?.length === 2
      && a.inline[0].name === 'a_shot.png' && a.inline[0].as === 'image'
      && a.inline[1].name === 'b_small.csv' && a.inline[1].as === 'document-text'
      && a.staged?.files?.length === 1 && a.staged.files[0].name === 'c_big.csv';
  }],
  ['44 inline and staged reach the model in the SAME request', () => {
    const j = get('case44')?.itemJson;
    // 771 is in the attached csv, 8823 on the last row of the staged one. Both present means the
    // two routes coexist in one turn — the only case that proves it.
    return j?.success === true && /771/.test(String(j.result)) && /8823/.test(String(j.result));
  }],
  ['45 a tool restriction omitting Read cannot silently defeat staging', () => {
    const j = get('case45')?.itemJson;
    if (!j || j.success !== true) return false;
    // Restrict Built-in Tools was ['Bash','Grep']. Without the applier adding Read the agent
    // cannot open the staged file and answers without it while still reporting success — a green
    // run with a wrong answer. 8823 is only obtainable by reading the file.
    return /8823/.test(String(j.result)) && !/CANNOT_READ/.test(String(j.result))
      && typeof j.diagnostics?.attachments?.staged?.dir === 'string';
  }],
  ['46 a pdf reaches the model as a base64 document block', () => {
    const j = get('case46')?.itemJson;
    if (!j || j.success !== true) return false;
    const a = j.diagnostics?.attachments;
    // 3947 exists only inside the generated PDF.
    return /3947/.test(String(j.result)) && a?.inline?.[0]?.as === 'document-pdf';
  }],
  ['47 a file over the size cap fails the item, naming it and the limit', () => {
    const c = get('case47');
    if (!c) return false;
    const j = c.itemJson ?? {};
    const msg = String(j.error ?? j.message);
    return /"huge"/.test(msg) && /2\.0 MB/.test(msg) && /limit of 1 MB/.test(msg);
  }],
  ['47 a file rejected by the cap costs nothing', () => {
    const d = det(get('case47'));
    return (d.total_cost_usd ?? 0) === 0 && !d.session_id;
  }],
  ['48 allowed extensions keeps the listed types and skips the rest', () => {
    const j = get('case48')?.itemJson;
    if (!j || j.success !== true) return false;   // a skip must never fail the item
    const a = j.diagnostics?.attachments;
    return /412/.test(String(j.result))
      && a?.count === 2
      && a.staged === null                        // the zip was skipped, NOT staged
      && a.skipped?.length === 1
      && a.skipped[0].propName === 'c_blob'
      && a.skipped[0].extension === 'zip';
  }],
  ['48 a filtered file is never staged — no temp dir is created for it', () => {
    // staged === null is asserted above; this pins the other half, that the run did not quietly
    // fall back to putting the excluded file on disk where the agent could still read it.
    const a = get('case48')?.itemJson?.diagnostics?.attachments;
    return !!a && a.inline?.length === 2 && a.inline.every((i) => i.name !== 'c_blob.zip');
  }],
  ['49 filtering everything out still runs, and still reports why', () => {
    const j = get('case49')?.itemJson;
    if (!j || j.success !== true) return false;
    const a = j.diagnostics?.attachments;
    return a?.count === 0 && a.inline?.length === 0 && a.staged === null && a.skipped?.length === 3;
  }],
  ['51 a 1.3 node left on Auto does attach', () => {
    const j = get('case51')?.itemJson;
    if (!j || j.success !== true) return false;
    const a = j.diagnostics?.attachments;
    // Same workflow as case50 but pinned at 1.3. The pair is the whole proof that `auto` is
    // version-aware: neither case alone distinguishes "auto works" from "auto is stuck".
    return a?.count === 3 && /412/.test(String(j.result));
  }],
  ['50 a workflow saved before the parameter does not start attaching on upgrade', () => {
    const j = get('case50')?.itemJson;
    if (!j || j.success !== true) return false;
    // The whole claim: the schema default is true, the node fallback is false, and n8n uses the
    // fallback for a key the stored workflow does not have. No key means nothing was collected.
    return !('attachments' in (j.diagnostics ?? {}));
  }],

  // Authentication. case53 is the one that proves the claim: the container is logged in, so a run
  // that cannot authenticate can only have been running on the credential.
  ['52 a credential runs the query and is named in diagnostics', () => {
    const j = get('case52')?.itemJson;
    return !!j && j.success === true && /pong/.test(String(j.result)) &&
      ['apiKey', 'oauthToken'].includes(j.diagnostics?.auth);
  }],
  ['53 an invalid credential fails, so it beat the host login', () => {
    const c = get('case53');
    // The container IS logged in, so a 401 can only have come from the credential. The node's own
    // error is a timeout — the CLI retries a 401 with backoff rather than failing fast — so the
    // timeout message says nothing about auth and the count from the raw log is the real evidence.
    return !!c && c.status !== 'success' && c.itemCount === 0 && c.authFailures > 0;
  }],
  ['53 the host login did not quietly answer instead', () => {
    const c = get('case53');
    // The other half, and the one that would catch a regression where the scrub stops working:
    // the same prompt on the host login returns "pong" in a couple of seconds (case52 does).
    return !!c && !/pong/i.test(JSON.stringify(c.itemJson ?? {}));
  }],
  ['54 a credential mode with nothing selected fails before spawning', () => {
    const c = get('case54');
    return !!c && c.status !== 'success' && /No credential selected/i.test(String(c.errorMessage ?? ''));
  }],

  // chat-model (cases 60-64): the AI Agent cluster. The asserted node is the Agent, whose item is
  // { output: ... } — a string normally, an object under Require Specific Output Format.
  ['60 the Agent accepts the chat model and answers', () => {
    const c = get('case60');
    return c.status === 'success' && /pong/i.test(String(c.itemJson?.output ?? ''));
  }],
  ['61 an Agent tool runs inside Claude Code, its value reaches the answer', () => {
    const c = get('case61');
    return c.status === 'success' && /73194/.test(String(c.itemJson?.output ?? ''));
  }],
  ['62 memory carries the first answer into the second call', () => {
    const c = get('case62');
    return c.status === 'success' && /chartreuse/i.test(String(c.itemJson?.output ?? ''));
  }],
  ['63 an invalid credential on the chat model fails the Agent, 401s in the log', () => {
    const c = get('case63');
    return !!c && c.status !== 'success' && c.authFailures > 0 && !/pong/i.test(JSON.stringify(c.itemJson ?? {}));
  }],
  ['64 Require Specific Output Format returns the schema-d object (R16)', () => {
    const c = get('case64');
    const out = c?.itemJson?.output;
    return c?.status === 'success' && !!out && typeof out === 'object' && /blue/i.test(String(out.answer ?? ''));
  }],
  ['65a the first call opens a session and answers', () => {
    const c = get('case65a');
    return c.status === 'success' && /OK/i.test(String(c.itemJson?.output ?? ''));
  }],
  ['65b a SECOND EXECUTION resumes the session — no Memory node, the session carries the fruit', () => {
    const c = get('case65b');
    return c.status === 'success' && /abacaxi/i.test(String(c.itemJson?.output ?? ''));
  }],
  ['65c a stable conversation key CREATES the session — no storage anywhere', () => {
    const c = get('case65c');
    return c.status === 'success' && /OK/i.test(String(c.itemJson?.output ?? ''));
  }],
  ['65d the same key RESUMES it in a new execution — deterministic hash, no patching', () => {
    const c = get('case65d');
    return c.status === 'success' && /jabuticaba/i.test(String(c.itemJson?.output ?? ''));
  }],
  ['66 the dedicated Task Tool runs Claude Code in the project and the count comes back', () => {
    const c = get('case66');
    return c.status === 'success' && /FILES=6\b/.test(String(c.itemJson?.output ?? ''));
  }],
  ['69 explicit Memory mode uses the Memory node and IGNORES the Session ID', () => {
    const c = get('case69');
    const model = Object.values(c?.modelRuns ?? {})[0];
    // Both halves matter: the recall proves memory worked, session_state "new" proves the
    // Session ID sitting on the node was not used.
    return (
      c?.status === 'success' &&
      /verde-lim/i.test(String(c.itemJson?.output ?? '')) &&
      model?.sessionState === 'new'
    );
  }],
  ['70 explicit Session mode resumes even with a Memory node connected', () => {
    const c = get('case70');
    const model = Object.values(c?.modelRuns ?? {})[0];
    return c?.status === 'success' && ['created', 'resumed'].includes(String(model?.sessionState));
  }],
  ['68 BOTH dedicated tools answer one question in a single turn', () => {
    const c = get('case68');
    const out = String(c?.itemJson?.output ?? '');
    // FILES can only come from the task tool, USAGE only from the usage tool.
    return c?.status === 'success' && /FILES=6\b/.test(out) && /USAGE=\d{1,3}\b/.test(out);
  }],
  ['67 the dedicated zero-arg Usage Tool reads plan windows through the Agent', () => {
    const c = get('case67');
    const out = String(c.itemJson?.output ?? '');
    // The model's own number proves nothing — it could have invented it. The tool's OWN run data
    // is the evidence: a JSON report that actually carries windows.
    const tool = c?.toolRuns?.['Plan Usage'];
    let report = null;
    try { report = tool ? JSON.parse(tool) : null; } catch { report = null; }
    return (
      c.status === 'success' &&
      !!report &&
      report.rateLimitsAvailable === true &&
      Array.isArray(report.windows) && report.windows.length > 0 &&
      !/NO_WINDOWS|Could not read/i.test(out)
    );
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
