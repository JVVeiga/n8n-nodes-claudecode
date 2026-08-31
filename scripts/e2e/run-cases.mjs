// Runs each imported test workflow through the n8n CLI inside the container and extracts the
// Claude Code node's output, so the manual checklist from SPEC.md can be evaluated mechanically.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const SCRATCH = new URL('.', import.meta.url).pathname;
const CONTAINER = process.env.E2E_CONTAINER ?? 'n8n-cc-e2e';

const only = process.argv.slice(2);

const ids = execFileSync('docker', ['exec', CONTAINER, 'node', '/tmp/ids.js'], { encoding: 'utf8' })
	.trim()
	.split('\n')
	.map((l) => l.split('\t'))
	.filter(([, name]) => name.startsWith('case'))
	.map(([id, name]) => ({ id, name }))
	.filter(({ name }) => only.length === 0 || only.some((o) => name.includes(o)))
	.sort((a, b) => a.name.localeCompare(b.name));

/** The CLI prints n8n log lines plus one pretty-printed JSON blob. Pull the blob out. */
function extractJson(raw) {
	const text = raw
		.split('\n')
		.filter((l) => !/\| debug \|/.test(l))
		.join('\n');
	// The blob opens on a log line — `<ts> | info  | {` — then continues as raw pretty JSON.
	const opener = text.match(/\| info\s+\| \{\n/);
	if (!opener) return null;
	const start = opener.index + opener[0].length - 2;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === '\\') esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(text.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

const results = [];

/** Runs a helper script inside the container and returns its stdout. */
const inContainer = (script, ...args) =>
	execFileSync('docker', ['exec', CONTAINER, 'node', `/tmp/${script}`, ...args], {
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
	});

/** Session id captured from an earlier case, so case08 has something real to resume. */
let capturedSessionId = null;

/** The chat model's session id from case65a, so case65b has a real session to resume. */
let capturedChatModelSessionId = null;

const PATCH_CHAT_MODEL_SESSION =
	"const { DatabaseSync } = require('node:sqlite');" +
	"const db = new DatabaseSync('/home/node/.n8n/database.sqlite');" +
	"const row = db.prepare(\"SELECT id, nodes FROM workflow_entity WHERE name LIKE 'case65b%'\").get();" +
	'const nodes = JSON.parse(row.nodes);' +
	"const model = nodes.find((n) => String(n.type).includes('claudeCodeChatModel'));" +
	'model.parameters.sessionId = process.argv[1];' +
	"db.prepare('UPDATE workflow_entity SET nodes = ? WHERE id = ?').run(JSON.stringify(nodes), row.id);" +
	"console.log(JSON.stringify({ workflow: row.id, sessionId: process.argv[1] }));";

for (const { id, name } of ids) {
	// case65b resumes the Claude session case65a's chat model opened, in a SEPARATE execution —
	// the real round-trip. It must be patched in from outside: a sub-node's output is not on the
	// `main` chain, so no expression in the workflow can read it (measured — the first case65
	// attempt died with "No data found from `main` input"). Same pattern as case08 below.
	if (name.startsWith('case65b')) {
		if (capturedChatModelSessionId) {
			const patched = execFileSync(
				'docker',
				['exec', CONTAINER, 'node', '-e', PATCH_CHAT_MODEL_SESSION, capturedChatModelSessionId],
				{ encoding: 'utf8' },
			).trim();
			process.stdout.write(`\n    patched case65b session: ${patched}\n`);
		} else {
			process.stdout.write(
				`\n=== ${name}\n    SKIPPED: no chat-model session captured — run case65a in the same pass.\n`,
			);
			continue;
		}
	}

	// case08 resumes case01's session. The generator can only write a placeholder, so patch the
	// real id in now — without this the CLI rejects it with "--resume requires a valid session ID".
	if (name.startsWith('case08')) {
		if (capturedSessionId) {
			const patched = inContainer('patch-session.js', capturedSessionId).trim();
			process.stdout.write(`\n    patched case08 session: ${patched}\n`);
		} else {
			process.stdout.write(
				`\n=== ${name}\n    SKIPPED: no session id captured from an earlier case. ` +
					`Run case01 in the same pass, or pass a session id by hand.\n`,
			);
			continue;
		}
	}

	process.stdout.write(`\n=== ${name}\n    id=${id} running... `);
	const started = Date.now();
	let raw = '';
	let exitCode = 0;
	try {
		raw = execFileSync(
			'docker',
			[
				'exec',
				'-e', 'N8N_RUNNERS_ENABLED=false',
				'-e', 'N8N_RUNNERS_BROKER_PORT=5699',
				CONTAINER, 'n8n', 'execute', `--id=${id}`,
			],
			{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
		);
	} catch (e) {
		exitCode = e.status ?? -1;
		raw = String(e.stdout ?? '') + String(e.stderr ?? '');
	}
	const wallMs = Date.now() - started;
	const slug = name.split(' ')[0];
	writeFileSync(`${SCRATCH}run-${slug}.log`, raw);

	let parsed = extractJson(raw);

	// `n8n execute --id` cannot report an execution that finishes almost instantly: its
	// post-execute promise loses the record and the command dies with "No active execution found"
	// from ActiveExecutions.getExecutionOrFail, having printed no JSON. The execution itself ran and
	// is stored correctly — case07d hits this, because an empty prompt makes the node throw in
	// ~0.4s. Fall back to the DB rather than recording a phantom failure.
	let readFromDb = false;
	if (!parsed && /No active execution found/.test(raw)) {
		try {
			const stored = JSON.parse(inContainer('read-exec.js', id));
			if (stored.found) {
				readFromDb = true;
				// The stored run data is n8n's flattened reference format, not plain JSON, so the
				// per-node breakdown is not reconstructed here. What the DB does give reliably is
				// whether the execution succeeded or errored, which is what these cases assert.
				parsed = { status: stored.status, data: { resultData: {} }, _fromDb: true };
				raw += `\n\n[read-exec.js fallback]\n${stored.raw ?? ''}`;
				writeFileSync(`${SCRATCH}run-${name.split(' ')[0]}.log`, raw);
			}
		} catch (dbError) {
			process.stdout.write(`\n    DB fallback failed: ${dbError.message}\n`);
		}
	}

	const runData = parsed?.data?.resultData?.runData ?? {};
	// The node's name was hardcoded to 'Claude Code', so a case naming it anything else — the Usage
	// node cases name it 'Claude Code Usage' — recorded zero items and looked like a silent pass.
	// Take whichever Claude node actually ran.
	const nodeName =
		Object.keys(runData).find((k) => /^Claude Code/.test(k)) ?? 'Claude Code';
	const ccRuns = runData[nodeName] ?? [];
	const cc = ccRuns[0] ?? {};
	// With onError: continueErrorOutput the node's item comes out of branch 1, not 0. Take the
	// first non-empty branch rather than assuming index 0.
	const branches = Array.isArray(cc?.data?.main) ? cc.data.main : [];
	const branchIdx = branches.findIndex((b) => Array.isArray(b) && b.length > 0);
	const items = branchIdx === -1 ? [] : branches[branchIdx];
	const setItems = runData['Read payload']?.[0]?.data?.main?.[0] ?? [];
	// What each ai_tool sub-node actually returned, keyed by node name. A tool's own output is
	// the only evidence that distinguishes "the tool answered" from "the model made it up".
	const toolRuns = {};
	for (const [nodeName, nodeRuns] of Object.entries(runData)) {
		const response = nodeRuns?.[0]?.data?.ai_tool?.[0]?.[0]?.json?.response;
		if (response !== undefined) toolRuns[nodeName] = response;
	}
	// Payloads the usage collector received during THIS case, read from its own executions. A
	// sub-node's report leaves the workflow entirely, so nothing in this execution's run data
	// can show it — the collector's execution record is the only evidence.
	// Polled, not read once: reports are sent with doNotWaitToFinish, so the collector's
	// execution row may not exist the instant the caller finishes. Three quick tries beat a
	// flaky assertion that blames the node for a race in the rig.
	let usageReports = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			usageReports = JSON.parse(inContainer('read-usage-reports.js', String(started)));
		} catch {
			usageReports = [];
		}
		if (usageReports.length > 0) break;
		execFileSync('sleep', ['1']);
	}
	// What the chat model reported about itself — `sessionState` is the only evidence that
	// distinguishes "resumed a session" from "read a flattened memory", and no answer text can
	// show it.
	const modelRuns = {};
	for (const [nodeName, nodeRuns] of Object.entries(runData)) {
		const json = nodeRuns?.[0]?.data?.ai_languageModel?.[0]?.[0]?.json;
		if (json?.sessionState !== undefined) {
			modelRuns[nodeName] = { sessionState: json.sessionState, sessionId: json.sessionId };
		}
	}
	const nodeError = cc?.error ?? parsed?.data?.resultData?.error ?? null;

	// A credential that cannot authenticate never reaches an item or a node error: the CLI takes a
	// 401 and RETRIES with backoff until the node's own timeout fires, so the only record of what
	// went wrong is in the raw log. Counted here rather than asserted on the timeout message,
	// because "it timed out" is also what a network problem looks like.
	const authFailures = (raw.match(/"error":"authentication_failed"/g) ?? []).length;

	// The CLI writes the node error to the log even when the JSON blob omits it.
	const loggedError =
		raw.match(/NodeOperationError: ([^\n]{0,400})/)?.[1] ??
		raw.match(/\| error \| ([^\n{]{0,300})/)?.[1] ??
		null;

	results.push({
		name,
		slug,
		id,
		wallMs,
		exitCode,
		status: parsed?.status ?? '(unparsed)',
		readFromDb,
		itemCount: items.length,
		itemJson: items[0]?.json ?? null,
		hasTopLevelErrorField: items[0] ? Object.prototype.hasOwnProperty.call(items[0], 'error') : null,
		setItemJson: setItems[0]?.json ?? null,
		authFailures,
		errorMessage: nodeError?.message ?? loggedError,
		errorDescription: nodeError?.description ?? null,
		errorType: nodeError?.type ?? null,
		errorContextKeys: nodeError?.context ? Object.keys(nodeError.context).sort() : null,
		errorContext: nodeError?.context ?? null,
		toolRuns,
		modelRuns,
		usageReports,
		outputBranchIndex: (() => {
			const main = cc?.data?.main;
			if (!Array.isArray(main)) return null;
			return main.findIndex((b) => Array.isArray(b) && b.length > 0);
		})(),
	});
	// Remember a session id for case08 to resume. It shows up in diagnostics on the success path,
	// in the failure item's details on a soft failure, and on the error context when the node threw
	// — a timed-out run is exactly the interesting thing to resume, so all three are checked.
	const sessionFromRun =
		items[0]?.json?.diagnostics?.sessionId ??
		items[0]?.json?.details?.session_id ??
		items[0]?.json?.details?.diagnostics?.sessionId ??
		nodeError?.context?.session_id ??
		null;
	if (sessionFromRun && !name.startsWith('case08')) {
		capturedSessionId = sessionFromRun;
	}
	// The chat model logs its run under a name that deliberately does NOT match /^Claude Code/
	// (that regex picks the Agent). Its session id lives on the sub-node's ai_languageModel run
	// data — captured here for case65b, since no expression inside a workflow can reach it.
	for (const [nodeName, nodeRuns] of Object.entries(runData)) {
		if (!/^CC Chat Model/.test(nodeName)) continue;
		const sub = nodeRuns?.[0]?.data?.ai_languageModel?.[0]?.[0]?.json;
		// Guarded on case65a specifically: capturing from ANY chat-model run meant case65b would
		// silently resume whichever case ran last if 65a was filtered out — it fails correctly,
		// but for a misleading reason.
		if (sub?.sessionId && name.startsWith('case65a')) {
			capturedChatModelSessionId = sub.sessionId;
		}
	}

	process.stdout.write(
		`done in ${(wallMs / 1000).toFixed(1)}s (exit ${exitCode}, ${parsed?.status ?? '?'}` +
			`${readFromDb ? ', from DB' : ''}${sessionFromRun ? ', session captured' : ''})\n`,
	);
}

// A filtered run must not destroy the rest of the baseline. It used to overwrite results.json
// wholesale, so re-running one case to check a fix threw away the twelve results that cost real
// money to produce. Merge instead: new results replace their own entry, everything else survives.
let merged = results;
if (only.length > 0) {
	try {
		const previous = JSON.parse(readFileSync(`${SCRATCH}results.json`, 'utf8'));
		const replaced = new Set(results.map((r) => r.name));
		merged = [...previous.filter((r) => !replaced.has(r.name)), ...results].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		console.log(`\n\nmerged ${results.length} case(s) into ${previous.length} existing`);
	} catch {
		console.log('\n\nno previous results.json to merge into');
	}
}

writeFileSync(`${SCRATCH}results.json`, JSON.stringify(merged, null, 2));
console.log(`wrote results.json (${merged.length} cases)`);
