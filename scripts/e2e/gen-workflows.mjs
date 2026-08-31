// Generates one n8n workflow per manual test case from SPEC.md, ready to import with
// `n8n import:workflow --separate --input=<dir>`. Each is a manual trigger -> Claude Code node,
// plus a Set node reading the payload fields the case is about, so the assertion is visible in the
// UI without digging through JSON.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('./workflows/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const PROJECT = '/workspace';
// Reads the fixture files one at a time, describing each at length. Measured on
// claude-sonnet-5 it runs 19-45s, so the timeouts below are set well under that floor:
// the point of these cases is that the timeout fires, not how long the work takes.
//
// It used to be paired with 45-60s timeouts and a comment claiming the fixture was six
// 2.5k-line files. The fixture is six 126-line files, so the prompt finished inside the
// timeout and four cases silently stopped testing anything — they asserted a timeout that
// never happened. Keep the timeouts tight, or re-measure when the fixture or model changes.
const OVERRUN_PROMPT =
	'Read every .ts file under /workspace/src one at a time and describe each one in a long, detailed paragraph. Do not parallelise. Do not write or edit anything.';
const FAST_PROMPT = 'Reply with exactly the word: pong. Nothing else.';

let idSeq = 0;
const nextId = () => `n${++idSeq}`;

/** n8n workflow ids are 16 alphanumeric characters. Derive one from the case name so it is stable
 * across regenerations and readable in `n8n execute --id=` output. */
const stableId = (name) => {
	const slug = name.split(' ')[0].replace(/[^a-zA-Z0-9]/g, '');
	return (slug + 'e2e0000000000000').slice(0, 16);
};

/**
 * The credentials n8n-up.sh imports. The ids are fixed and shared between the two files: a
 * workflow references a credential by id, so a generated id here and a random one there would
 * import cleanly and then fail at run time with "credentials not found".
 */
const CREDENTIALS = {
	// The operator's real token, imported only when the matching variable is exported.
	oauth: { id: 'e2ecredoauth0000', name: 'E2E Claude Code OAuth Token', type: 'claudeCodeOAuthTokenApi' },
	apiKey: { id: 'e2ecredapikey000', name: 'E2E Claude Code API Key', type: 'claudeCodeApi' },
	// Always imported, and deliberately worthless. Nothing here is a secret.
	decoy: { id: 'e2ecreddecoy0000', name: 'E2E Decoy API Key (invalid on purpose)', type: 'claudeCodeApi' },
};

/** Which real credential the operator's environment can supply. Mirrors n8n-up.sh's own check. */
const REAL_CREDENTIAL = process.env.CLAUDE_CODE_OAUTH_TOKEN
	? { mode: 'oauthToken', cred: CREDENTIALS.oauth }
	: process.env.ANTHROPIC_API_KEY
		? { mode: 'apiKey', cred: CREDENTIALS.apiKey }
		: null;

function workflow({ name, notes, claude, outputFormat = 'structured', onError, readFields = [], version = 1.1, auth }) {
	const triggerId = nextId();
	const claudeId = nextId();
	const nodes = [
		{
			parameters: {},
			id: triggerId,
			name: 'When clicking Execute',
			type: 'n8n-nodes-base.manualTrigger',
			typeVersion: 1,
			position: [0, 0],
		},
		{
			parameters: {
				operation: 'query',
				prompt: claude.prompt,
				model: claude.model ?? 'claude-sonnet-5',
				effort: claude.effort ?? 'medium',
				maxTurns: claude.maxTurns ?? 40,
				timeout: claude.timeout ?? 300,
				projectPath: claude.projectPath ?? PROJECT,
				outputFormat,
				allowedTools: [],
				disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
				restrictTools: [],
				additionalOptions: { debug: true, ...(claude.additionalOptions ?? {}) },
				// Absent unless the case is about authentication, so every other workflow stays
				// byte-identical to the one it generated before this parameter existed.
				...(auth ? { authSource: auth.mode } : {}),
			},
			id: claudeId,
			name: 'Claude Code',
			type: '@joaoveiga/n8n-nodes-claudecode.claudeCode',
			typeVersion: version,
			position: [220, 0],
			...(auth?.cred
				? { credentials: { [auth.cred.type]: { id: auth.cred.id, name: auth.cred.name } } }
				: {}),
			...(onError ? { onError } : {}),
		},
	];

	const connections = {
		'When clicking Execute': { main: [[{ node: 'Claude Code', type: 'main', index: 0 }]] },
	};

	if (readFields.length > 0) {
		const setId = nextId();
		nodes.push({
			parameters: {
				mode: 'manual',
				duplicateItem: false,
				assignments: {
					assignments: readFields.map((f, i) => ({
						id: `a${i}`,
						name: f,
						value: `={{ $json.${f} }}`,
						type: 'string',
					})),
				},
				includeOtherFields: false,
				options: {},
			},
			id: setId,
			name: 'Read payload',
			type: 'n8n-nodes-base.set',
			typeVersion: 3.4,
			position: [460, onError === 'continueErrorOutput' ? 160 : 0],
		});
		// The error output is index 1 when the node is set to continueErrorOutput.
		const outputIndex = onError === 'continueErrorOutput' ? 1 : 0;
		const main = [];
		for (let i = 0; i <= outputIndex; i++) main.push(i === outputIndex ? [{ node: 'Read payload', type: 'main', index: 0 }] : []);
		connections['Claude Code'] = { main };
	}

	return {
		// A stable id, derived from the case name, so `n8n import:workflow` UPDATES the workflow
		// instead of creating another copy. Without it every regeneration doubled the workflow
		// table, and `n8n execute --id` then ran whichever stale duplicate came first.
		id: stableId(name),
		name,
		nodes,
		connections,
		settings: { executionOrder: 'v1' },
		active: false,
		pinData: {},
		meta: { testCaseNotes: notes },
	};
}

const METRIC_FIELDS = [
	'timedOut',
	'terminationReason',
	'total_cost_usd',
	'num_turns',
	'usageReliable',
	'session_id',
	'result',
	'wrapUpSucceeded',
];

const cases = [
	workflow({
		name: 'case01 graceful timeout - wrap-up + real metrics',
		notes: 'timeout 60, grace 20. EXPECT: execution fails red. Error message names the timeout and carries turns + cost + session. error.context / Other info holds the full payload. terminationReason=timeout_graceful, wrapUpSucceeded=true, usageReliable=true.',
		claude: { prompt: OVERRUN_PROMPT, timeout: 15, additionalOptions: { debug: true, wrapUpGraceSeconds: 5 } },
	}),
	workflow({
		name: 'case02 hard abort - grace 0',
		notes: 'timeout 45, grace 0. EXPECT: red. terminationReason=timeout_hard_abort, total_cost_usd=null, usageReliable=false, but session_id and toolTimeline present. Returns up to ~3s after the timeout (SDK teardown).',
		claude: { prompt: OVERRUN_PROMPT, timeout: 12, additionalOptions: { debug: true, wrapUpGraceSeconds: 0 } },
	}),
	workflow({
		name: 'case03 wrap-up cannot finish',
		notes: 'timeout 45, grace 2 - too short for a wrap-up turn. EXPECT: red. terminationReason=timeout_graceful, wrapUpSucceeded=false, but usageReliable=true and a real cost, because the interrupt result already landed.',
		claude: { prompt: OVERRUN_PROMPT, timeout: 12, additionalOptions: { debug: true, wrapUpGraceSeconds: 2 } },
	}),
	workflow({
		name: 'case04a normal run - structured (REGRESSION CHECK)',
		notes: 'THE IMPORTANT ONE. Fast prompt, no timeout. Compare output field-by-field against 0.7.2. Streaming input mode changed how EVERY run delivers its prompt, so a regression shows up here.',
		claude: { prompt: FAST_PROMPT, timeout: 300 },
		outputFormat: 'structured',
	}),
	workflow({
		name: 'case04b normal run - text',
		notes: 'Same as 04a with outputFormat=text. Compare against 0.7.2.',
		claude: { prompt: FAST_PROMPT, timeout: 300 },
		outputFormat: 'text',
	}),
	workflow({
		name: 'case04c normal run - messages',
		notes: 'Same as 04a with outputFormat=messages. Compare against 0.7.2.',
		claude: { prompt: FAST_PROMPT, timeout: 300 },
		outputFormat: 'messages',
	}),
	workflow({
		name: 'case05 timeout with continueRegularOutput',
		notes: 'timeout 60, grace 20, On Error = Continue (using regular output). EXPECT: execution GREEN, payload on the main output, Read payload node shows the metrics.',
		claude: { prompt: OVERRUN_PROMPT, timeout: 15, additionalOptions: { debug: true, wrapUpGraceSeconds: 5 } },
		onError: 'continueRegularOutput',
		readFields: METRIC_FIELDS,
	}),
	workflow({
		name: 'case06 timeout with continueErrorOutput (AC-14)',
		notes: 'timeout 60, grace 20, On Error = Continue (using error output). EXPECT: item on the ERROR branch (not success), and Read payload resolves total_cost_usd / session_id / result. This is the fix in commit 2fdeb5b - without the top-level error field the item would come out of the success branch.',
		claude: { prompt: OVERRUN_PROMPT, timeout: 15, additionalOptions: { debug: true, wrapUpGraceSeconds: 5 } },
		onError: 'continueErrorOutput',
		readFields: METRIC_FIELDS,
	}),
	workflow({
		name: 'case07b typeVersion 1 - must behave like 0.7.2 (AC-15)',
		notes: 'Node pinned at typeVersion 1, timeout 12, grace NOT set. EXPECT: grace resolves to 0 (check the debug log for wrapUpGraceSeconds), hard kill at the timeout, no top-level error field. diagnostics and the observable facts still present.',
		claude: { prompt: OVERRUN_PROMPT, timeout: 12 },
		version: 1,
	}),
	workflow({
		name: 'case07c typeVersion 1.1 - grace defaults to 60',
		notes: 'Node at 1.1, timeout 300, grace NOT set. EXPECT: the debug log line "Starting Claude Code execution" reports wrapUpGraceSeconds=60 and wrapUpAtMs=240000. Fast prompt, so it finishes normally - this checks the default, not the timeout.',
		claude: { prompt: FAST_PROMPT, timeout: 300 },
	}),
	workflow({
		name: 'case07d non-timeout failure on the error branch',
		notes:
			'Prompt is an expression resolving to empty at runtime, On Error = Continue (using error ' +
			'output). EXPECT: the node\'s own "Prompt is required and cannot be empty" check fires and ' +
			'the failure lands on the ERROR branch. This is the adjacent bug fixed in 2fdeb5b - on v1 ' +
			'it would come out of the success branch.\n\n' +
			'It used to pass a LITERAL empty string, which never reached the node at all: `prompt` is ' +
			'declared required:true, so n8n rejects the whole workflow in ' +
			'WorkflowExecute.checkForWorkflowIssues with "Parameter \'Prompt\' is required" and stores ' +
			'an execution with empty runData. The case asserted a branch-1 item that could not exist. ' +
			'An expression passes static validation and resolves to empty at run time, which is the ' +
			'only way the node guard is reachable — and the only way a real workflow hits it.',
		claude: { prompt: '={{ $json.promptFieldThatDoesNotExist }}', timeout: 60 },
		onError: 'continueErrorOutput',
		readFields: ['error'],
	}),
	workflow({
		name: 'case09 text format + continueOnFail on timeout',
		notes: 'timeout 60, grace 20, outputFormat=text, On Error = Continue (using regular output). EXPECT: the payload is present - this path was refactored in 6659f69 to stop building its own shape.',
		claude: { prompt: OVERRUN_PROMPT, timeout: 15, additionalOptions: { debug: true, wrapUpGraceSeconds: 5 } },
		outputFormat: 'text',
		onError: 'continueRegularOutput',
		readFields: METRIC_FIELDS,
	}),
];

// Case 08 needs the session id from case 01, so it is generated with a placeholder to fill in.
const resume = workflow({
	name: 'case08 resume the timed-out session',
	notes: 'Run case01 first, copy its session_id, paste it into the Session ID field here, then execute. EXPECT: Claude picks up where it left off instead of starting over.',
	claude: { prompt: 'Continue exactly where you left off. What file were you on?', timeout: 120 },
});
resume.nodes[1].parameters.operation = 'continue';
resume.nodes[1].parameters.sessionId = 'PASTE_SESSION_ID_FROM_CASE01';
cases.push(resume);

// typeVersion 1.2 cases. The point of these is not that 1.2 works in isolation — the unit tests
// cover the envelope — but that 1.2 and 1.1 coexist in ONE n8n instance without 1.2 leaking
// backwards. The v11 twins below run the same prompt on the old version for exactly that contrast.
const V12_PROMPT = 'Reply with exactly the word: pong. Nothing else.';

for (const format of ['structured', 'messages', 'text']) {
	cases.push(
		workflow({
			name: `case20${format[0]} typeVersion 1.2 unified envelope - ${format}`,
			notes:
				`Node pinned at typeVersion 1.2, outputFormat ${format}. EXPECT: one envelope with ` +
				'result, success, errorText, metrics{duration_ms,num_turns,total_cost_usd,usage,' +
				'modelUsage,session_id} and diagnostics. No messageCount. The transcript appears only ' +
				'for messages and structured; the summary only for structured.',
			claude: { prompt: V12_PROMPT, timeout: 120 },
			outputFormat: format,
			version: 1.2,
		}),
	);
}

cases.push(
	workflow({
		name: 'case21 typeVersion 1.1 alongside 1.2 - legacy shape intact',
		notes:
			'Same prompt and format as case20s, pinned at 1.1. EXPECT the OLD shape: flat ' +
			'duration_ms and total_cost_usd, no metrics object, no errorText. This is the case that ' +
			"catches 1.2 leaking backwards into existing workflows.",
		claude: { prompt: V12_PROMPT, timeout: 120 },
		outputFormat: 'text',
		version: 1.1,
	}),
);

cases.push(
	workflow({
		name: 'case22 typeVersion 1.2 unknown cost reports null',
		notes:
			'1.2 with a hard abort, so no usable result message arrives. EXPECT metrics.total_cost_usd ' +
			'and metrics.num_turns to be null, NOT 0 — the legacy text format reported 0 here, which ' +
			'claimed a run was free when it was not (F-01). continueRegularOutput so the item is ' +
			'readable rather than thrown.',
		claude: { prompt: OVERRUN_PROMPT, timeout: 12, additionalOptions: { debug: true, wrapUpGraceSeconds: 0 } },
		version: 1.2,
		onError: 'continueRegularOutput',
	}),
);

/**
 * The Usage node. It had no coverage here at all, which mattered: its execute() spawns a real CLI
 * through readUsage, and readUsage is the one module with no unit tests by design (it needs the
 * SDK's control-request surface). So this case was the only thing that could exercise it, and it
 * did not exist.
 *
 * The read sends no prompt, so it is free — unlike every Claude Code case in this file.
 */
function usageWorkflow({ name, notes, options = {} }) {
	const triggerId = nextId();
	const usageId = nextId();
	return {
		id: stableId(name),
		name,
		nodes: [
			{
				parameters: {},
				id: triggerId,
				name: 'When clicking Execute',
				type: 'n8n-nodes-base.manualTrigger',
				typeVersion: 1,
				position: [0, 0],
			},
			{
				parameters: { operation: 'read', projectPath: PROJECT, timeout: 60, usageOptions: options },
				id: usageId,
				name: 'Claude Code Usage',
				type: '@joaoveiga/n8n-nodes-claudecode.claudeCodeUsage',
				typeVersion: 1,
				position: [220, 0],
			},
		],
		connections: {
			'When clicking Execute': { main: [[{ node: 'Claude Code Usage', type: 'main', index: 0 }]] },
		},
		settings: { executionOrder: 'v1' },
		active: false,
		pinData: {},
		meta: { testCaseNotes: notes },
	};
}

cases.push(
	usageWorkflow({
		name: 'case30 usage node reads plan capacity',
		notes:
			'EXPECT: one item with authenticated, planLimitsApply, rateLimitsAvailable, windows[], ' +
			'account{} and diagnostics{}. No prompt is sent, so session.totalCostUsd is 0 and nothing ' +
			'is billed. This is the only automated check that exercises readUsage against a real CLI.',
	}),
	usageWorkflow({
		name: 'case31 usage node withholds the email unless asked',
		notes:
			'Same read with Include Account Email on. EXPECT account.email present here and absent in ' +
			'case30 — it is personal data, so the default must not leak it.',
		options: { includeAccountEmail: true },
	}),
);

// ---------------------------------------------------------------------------------------------
// Attachment cases. These are the only ones whose input is binary data, so they need a node in
// front of Claude Code that produces some. A Code node is used rather than a fixture file in the
// container: the bytes are generated here, so the assertion and the data it asserts on live in
// one place, and nothing binary is committed.
// ---------------------------------------------------------------------------------------------

/** A solid-colour PNG, built byte by byte. Same generator as the spike that proved image blocks
 * reach the model at all — see .specs/features/attachments/spikes/. */
function solidPng(size, [r, g, b]) {
	const crcTable = [];
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crcTable[i] = c >>> 0;
	}
	const crc32 = (buf) => {
		let crc = 0xffffffff;
		for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
		return (crc ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: truecolour
	const raw = Buffer.alloc(size * (1 + size * 3));
	for (let y = 0; y < size; y++) {
		const row = y * (1 + size * 3);
		raw[row] = 0; // filter: none
		for (let x = 0; x < size; x++) {
			raw[row + 1 + x * 3] = r;
			raw[row + 2 + x * 3] = g;
			raw[row + 3 + x * 3] = b;
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

/**
 * manualTrigger -> Code (produces the binary) -> Claude Code -> Set.
 *
 * The Code node returns `binary` with base64 `data`, which is exactly the shape an upstream
 * HTTP Request or Monday node produces, so this exercises `getBinaryDataBuffer` for real.
 */
function attachmentWorkflow({
	name,
	notes,
	files,
	prompt,
	binaryProperties,
	attachAllBinaries = 'auto',
	additionalOptions = {},
	onError,
	readFields = [],
	timeout = 120,
	// Empty means the full built-in tool set. A non-empty list is what makes the stagedAttachments
	// applier's Read-injection branch reachable at all — see case45.
	restrictTools = [],
	// 1.2 by default so these cases keep exercising the version most stored workflows are on.
	// case51 pins 1.3 to prove the other half of what `auto` means.
	version = 1.2,
}) {
	const entries = Object.entries(files)
		.map(
			([prop, f]) =>
				`    ${JSON.stringify(prop)}: { data: ${JSON.stringify(f.base64)}, mimeType: ${JSON.stringify(f.mimeType)}, fileName: ${JSON.stringify(f.fileName)} }`,
		)
		.join(',\n');
	const code = `return [{\n  json: {},\n  binary: {\n${entries}\n  },\n}];`;

	const wf = workflow({
		name,
		notes,
		claude: { prompt, timeout, additionalOptions },
		onError,
		readFields,
		version,
	});

	// Splice the Code node in between the trigger and Claude Code, and rewire.
	wf.nodes.splice(1, 0, {
		parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: code },
		id: nextId(),
		name: 'Make binary',
		type: 'n8n-nodes-base.code',
		typeVersion: 2,
		position: [180, 0],
	});
	wf.nodes.find((node) => node.name === 'Claude Code').position = [400, 0];
	const readPayload = wf.nodes.find((node) => node.name === 'Read payload');
	if (readPayload) readPayload.position = [640, onError === 'continueErrorOutput' ? 160 : 0];

	wf.connections['When clicking Execute'] = {
		main: [[{ node: 'Make binary', type: 'main', index: 0 }]],
	};
	wf.connections['Make binary'] = {
		main: [[{ node: 'Claude Code', type: 'main', index: 0 }]],
	};

	const claude = wf.nodes.find((node) => node.name === 'Claude Code');
	// `null` omits the key entirely, which is how a workflow saved before the parameter existed
	// looks on disk. n8n then resolves it through the node's own fallback rather than the schema
	// default — see case50.
	// Binary Properties only DISPLAYS when Attach All Binaries is Off, and n8n strips a parameter
	// whose display condition is not met before the node ever sees it — so a case naming properties
	// while Attach All is on Auto reads an empty list and attaches nothing. That is the real UI
	// contract, not a workaround: naming properties means "not all of them".
	const attachAll =
		attachAllBinaries === 'auto' && binaryProperties ? 'off' : attachAllBinaries;
	if (attachAll !== null) claude.parameters.attachAllBinaries = attachAll;
	claude.parameters.binaryProperties = binaryProperties ?? '';
	// Attachments are the point of these cases; the agent must not be able to "solve" them by
	// reading the fixture project instead.
	claude.parameters.projectPath = PROJECT;
	claude.parameters.restrictTools = restrictTools;

	return wf;
}

const SEA_GREEN_PNG = solidPng(64, [0x2e, 0x8b, 0x57]);
const MARKER_CSV = 'sku,qty\nWIDGET-7741,412\nGIZMO-9,3\n';
// Over the 1 KB inline limit set on case42, with the answer buried past the first row so a model
// that guessed from the hint block rather than reading the file would get it wrong.
const BIG_CSV = `sku,qty\n${'FILLER-000,1\n'.repeat(400)}NEEDLE-5150,8823\n`;

cases.push(
	attachmentWorkflow({
		name: 'case40 attachment - image inline, vision with no tools',
		notes:
			'A 64x64 solid sea-green PNG on binary property "shot", sent as an image content block. ' +
			'EXPECT the result to name the colour (green). diagnostics.attachments.inline[0].as must ' +
			'be "image" and staged must be null. This is the case that proves an image reaches the ' +
			'model directly — no filesystem, no Read tool.',
		files: {
			shot: {
				base64: SEA_GREEN_PNG.toString('base64'),
				mimeType: 'image/png',
				fileName: 'shot.png',
			},
		},
		binaryProperties: 'shot',
		prompt:
			'Answer in one word only. What colour fills the attached image? If you cannot see an image, answer exactly NO_IMAGE.',
		readFields: ['result'],
	}),
	attachmentWorkflow({
		name: 'case41 attachment - csv inline as a document block',
		notes:
			'A 3-row CSV on binary property "data". EXPECT the result to be 412 — a value that exists ' +
			'nowhere but in the attached file. diagnostics.attachments.inline[0].as must be ' +
			'"document-text".',
		files: {
			data: {
				base64: Buffer.from(MARKER_CSV, 'utf8').toString('base64'),
				mimeType: 'text/csv',
				fileName: 'export.csv',
			},
		},
		binaryProperties: 'data',
		prompt:
			'Answer with the number only. What qty does SKU WIDGET-7741 have in the attached document? If you see no document, answer NO_DOC.',
		readFields: ['result'],
	}),
	attachmentWorkflow({
		name: 'case42 attachment - oversized text staged to disk and read',
		notes:
			'A ~5 KB CSV with Inline Text Size Limit set to 1 KB, so it is staged instead of attached. ' +
			'EXPECT diagnostics.attachments.staged.dir to be populated, inline to be empty, and the ' +
			'result to be 8823 — which is on the LAST row, so the agent had to actually Read the file ' +
			'rather than infer from the hint block. Also proves additionalDirectories works and the ' +
			'temp dir is reachable from inside the container.',
		files: {
			dump: {
				base64: Buffer.from(BIG_CSV, 'utf8').toString('base64'),
				mimeType: 'text/csv',
				fileName: 'dump.csv',
			},
		},
		binaryProperties: 'dump',
		additionalOptions: { debug: true, inlineTextLimitKb: 1 },
		prompt:
			'Answer with the number only. What qty does SKU NEEDLE-5150 have? The file is staged on disk; read it. If you cannot find it, answer NOT_FOUND.',
		readFields: ['result'],
	}),
	attachmentWorkflow({
		name: 'case43 attachment - a named property that is not on the item fails the item',
		notes:
			'Binary Properties names "screenshot", the item carries only "data". EXPECT branch 1 (the ' +
			'error output) with a message naming "screenshot" and listing what the item does have, and ' +
			'NO spend — query is never called. Silently answering without the evidence is the failure ' +
			'mode this guards against.',
		files: {
			data: {
				base64: Buffer.from(MARKER_CSV, 'utf8').toString('base64'),
				mimeType: 'text/csv',
				fileName: 'export.csv',
			},
		},
		binaryProperties: 'screenshot',
		prompt: FAST_PROMPT,
		onError: 'continueErrorOutput',
		readFields: ['error', 'message'],
	}),
);

// The first four cases each exercise one route with one file, a named property list, and no tool
// restriction. These four cover what that leaves: the toggle, several files at once, the two routes
// meeting in one item, the third block type, the size cap, and — the one that matters most — the
// guard that stops a tool restriction from silently defeating staging.

/** A one-page PDF with correct xref offsets, built here so no binary is committed. Same generator
 * as the spike that proved base64 PDF blocks reach the model. */
function onePagePdf(text) {
	const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET\n`;
	const objs = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
		`<< /Length ${content.length} >>\nstream\n${content}endstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
	];
	let pdf = '%PDF-1.4\n';
	const offsets = [];
	objs.forEach((body, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xrefAt = pdf.length;
	pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
	return Buffer.from(pdf, 'latin1');
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

cases.push(
	attachmentWorkflow({
		name: 'case44 attachment - attach all, several files, inline and staged together',
		notes:
			'Attach All Binaries with three properties and no name list: a PNG, a small CSV, and a CSV ' +
			'over the 1 KB inline limit. EXPECT diagnostics.attachments.count 3, inline holding the ' +
			'image and the small csv IN PROPERTY-NAME ORDER (a_shot.png then b_small.csv), and staged ' +
			'holding c_big.csv. The result must contain BOTH 771 (small csv, attached) and 8823 (last ' +
			'row of the staged csv, so it had to Read). This is the only case where the two routes meet ' +
			'in one request, and the only one that proves the toggle and multi-file ordering at all.',
		files: {
			a_shot: { base64: SEA_GREEN_PNG.toString('base64'), mimeType: 'image/png', fileName: 'a_shot.png' },
			b_small: { base64: b64('sku,qty\nSMALL-1,771\n'), mimeType: 'text/csv', fileName: 'b_small.csv' },
			c_big: { base64: b64(BIG_CSV), mimeType: 'text/csv', fileName: 'c_big.csv' },
		},
		attachAllBinaries: 'on',
		additionalOptions: { debug: true, inlineTextLimitKb: 1 },
		prompt:
			'Answer with exactly two numbers separated by a space, nothing else: first the qty of SKU SMALL-1, then the qty of SKU NEEDLE-5150. One of the files is on disk; read it.',
		readFields: ['result'],
		timeout: 180,
	}),
	attachmentWorkflow({
		name: 'case45 attachment - a tool restriction cannot silently defeat staging',
		notes:
			'A staged file with Restrict Built-in Tools set to Bash and Grep, which OMITS Read. Without ' +
			'the stagedAttachments applier adding Read, the agent cannot open the file and answers ' +
			'without the evidence while still reporting success — a green run with a wrong answer, ' +
			'which is the exact failure this guard exists to prevent. EXPECT result 8823 and ' +
			'diagnostics.attachments.staged populated. This is the only requirement whose whole purpose ' +
			'is preventing a false green, and the only one that can only break in a real container.',
		files: {
			dump: { base64: b64(BIG_CSV), mimeType: 'text/csv', fileName: 'dump.csv' },
		},
		binaryProperties: 'dump',
		restrictTools: ['Bash', 'Grep'],
		additionalOptions: { debug: true, inlineTextLimitKb: 1 },
		prompt:
			'Answer with the number only. What qty does SKU NEEDLE-5150 have? The file is on disk; read it. If you cannot open it, answer CANNOT_READ.',
		readFields: ['result'],
		timeout: 180,
	}),
	attachmentWorkflow({
		name: 'case46 attachment - pdf inline as a base64 document block',
		notes:
			'A one-page PDF built byte by byte. EXPECT result 3947 — a value that exists only inside ' +
			'the PDF — and inline[0].as === "document-pdf". The third and last block type; the other ' +
			'two are covered by case40 and case41. Proven against the real API by a spike before this ' +
			'was built, but never through the container until now.',
		files: {
			invoice: {
				base64: onePagePdf('Invoice ZX-88: total 3947 EUR').toString('base64'),
				mimeType: 'application/pdf',
				fileName: 'invoice.pdf',
			},
		},
		binaryProperties: 'invoice',
		prompt:
			'Answer with the number only. What is the total in the attached PDF? If you see no PDF, answer NO_PDF.',
		readFields: ['result'],
	}),
	attachmentWorkflow({
		name: 'case47 attachment - a file over the size cap fails the item',
		notes:
			'A 2 MB file with Max Attachment Size set to 1 MB. EXPECT the error branch with a message ' +
			'naming the property, its size and the limit, and NO spend — the cap is checked before ' +
			'query() is called. Distinct from case43, which covers a property that is not on the item ' +
			'at all: this one covers a property that is there and too big.',
		files: {
			huge: {
				base64: Buffer.alloc(2 * 1024 * 1024, 0x41).toString('base64'),
				mimeType: 'text/plain',
				fileName: 'huge.txt',
			},
		},
		binaryProperties: 'huge',
		additionalOptions: { debug: true, maxAttachmentMb: 1 },
		prompt: FAST_PROMPT,
		onError: 'continueErrorOutput',
		readFields: ['error', 'message'],
	}),
);

// ---------------------------------------------------------------------------------------------
// Allowed Extensions, and the upgrade-safety claim behind the new Attach All default.
// ---------------------------------------------------------------------------------------------

const MIXED_FILES = {
	a_shot: { base64: SEA_GREEN_PNG.toString('base64'), mimeType: 'image/png', fileName: 'a_shot.png' },
	b_data: { base64: b64(MARKER_CSV), mimeType: 'text/csv', fileName: 'b_data.csv' },
	c_blob: {
		// Real zip bytes: 'PK\x03\x04' then padding. Never routable inline, so without the filter
		// it would be staged — which is exactly what the filter has to prevent.
		base64: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]).toString('base64'),
		mimeType: 'application/zip',
		fileName: 'c_blob.zip',
	},
};

cases.push(
	attachmentWorkflow({
		name: 'case48 attachment - allowed extensions keeps some and skips the rest',
		notes:
			'Attach All with a PNG, a CSV and a ZIP, and Allowed Extensions set to png + csv. EXPECT ' +
			'the run to SUCCEED (a skip is not a failure), result 412 from the csv, ' +
			'diagnostics.attachments.count 2, staged null — the zip must NOT be staged — and ' +
			'skipped holding exactly c_blob/c_blob.zip/zip. If the zip were staged instead of ' +
			'skipped, additionalDirectories would be set and staged would not be null.',
		files: MIXED_FILES,
		attachAllBinaries: 'on',
		additionalOptions: { debug: true, allowedExtensions: ['png', 'csv'] },
		prompt:
			'Answer with the number only. What qty does SKU WIDGET-7741 have in the attached document?',
		readFields: ['result'],
	}),
	attachmentWorkflow({
		name: 'case49 attachment - every file filtered out still runs and still reports',
		notes:
			'Same three files, Allowed Extensions set to pdf only, so nothing matches. EXPECT the run ' +
			'to SUCCEED with no attachment at all: count 0, skipped holding all three, staged null. ' +
			'This is the case that proves a filter can empty the set without failing the item, and ' +
			'that the report still exists to say so.',
		files: MIXED_FILES,
		attachAllBinaries: 'on',
		additionalOptions: { debug: true, allowedExtensions: ['pdf'] },
		prompt: FAST_PROMPT,
		readFields: ['result'],
	}),
	attachmentWorkflow({
		name: 'case50 attachment - a workflow saved before the parameter does not start attaching',
		notes:
			'The upgrade-safety case. The workflow JSON has NO attachAllBinaries key and NO ' +
			'binaryProperties value, exactly like a node saved before this release, but the item does ' +
			'carry binary data. The schema default is true; the node fallback is false. n8n resolves ' +
			'with get(node.parameters, name, fallbackValue) and never consults the schema at run ' +
			'time, so EXPECT nothing attached: diagnostics must have NO attachments key at all. If ' +
			'that key appears, upgrading the package silently changed every stored workflow.',
		files: MIXED_FILES,
		attachAllBinaries: null,
		prompt: FAST_PROMPT,
		readFields: ['result'],
	}),
);

cases.push(
	attachmentWorkflow({
		name: 'case51 attachment - a 1.3 node on Auto does attach',
		notes:
			'The other half of case50. Identical workflow — no attachAllBinaries key, binary data on ' +
			'the item — but the node is pinned at typeVersion 1.3. The schema default `auto` resolves ' +
			'against the version in params.ts, so EXPECT it to attach: diagnostics.attachments present ' +
			'with count 3. Together the two cases prove auto means off below 1.3 and on from 1.3, ' +
			'which is what lets the feature default on for new nodes without touching stored ones.',
		files: MIXED_FILES,
		attachAllBinaries: null,
		version: 1.3,
		prompt:
			'Answer with the number only. What qty does SKU WIDGET-7741 have in the attached document?',
		readFields: ['result'],
	}),
);

// --- Authentication (feature auth-credentials) ---------------------------------------------
//
// What only a container can show: that the credential's env var actually reaches the spawned CLI
// and OVERRIDES the host login. The unit tests prove which environment gets built; they cannot
// prove the CLI honours it.
//
// case53 is the load-bearing one. The container is logged in and every other case runs on that
// login, so a run that fails to authenticate can only have failed on the credential — which means
// the credential replaced the host's. A passing case52 alone would not distinguish "the credential
// worked" from "the credential was ignored and the host answered".
// Generated only when the shell running THIS script can supply a real credential. Announced,
// because a case that quietly stops existing is how this rig lost four timeout cases once already:
// the import never deletes, so a regeneration without the token leaves the previous case52 in the
// database while dropping it from `workflows/`, and the verdict then reports SKIP as if the rig had
// a gap rather than the generator having been run in the wrong shell.
if (!REAL_CREDENTIAL) {
	console.warn(
		'\n!! case52 NOT generated: neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set in\n' +
			'   this shell. Export one and regenerate, or the credential-succeeds case is missing.\n',
	);
}
if (REAL_CREDENTIAL) {
	cases.push(
		workflow({
			name: 'case52 auth - a credential runs the query instead of the host login',
			notes:
				'Authentication set to the operator\'s own credential. EXPECT: success, result=pong, and ' +
				'diagnostics.auth naming the mode. A host-mode run has NO auth key at all — that absence ' +
				'is what let this ship without a new typeVersion.',
			claude: { prompt: FAST_PROMPT, timeout: 120, effort: 'low' },
			auth: { mode: REAL_CREDENTIAL.mode, cred: REAL_CREDENTIAL.cred },
			readFields: ['result'],
		}),
	);
}

cases.push(
	workflow({
		name: 'case53 auth - an invalid credential fails, proving it beat the host login',
		notes:
			'A deliberately invalid API key, on a container that IS logged in. EXPECT: red, with an ' +
			'authentication error from the API. If the run succeeds the credential was ignored and the ' +
			'host answered — which is the exact bug this feature exists to prevent.\n\n' +
			'MEASURED: the CLI does not fail fast on a 401 — it retries with backoff, so the run ends ' +
			'on the node timeout with 0 assistant turns. The first 401 lands at ~600ms, which is why ' +
			'the timeout here is 20s and not the 120s it was written with: waiting two minutes to ' +
			'observe something that happened in under a second is pure wall clock.',
		claude: {
			prompt: FAST_PROMPT,
			timeout: 20,
			effort: 'low',
			additionalOptions: { debug: true, wrapUpGraceSeconds: 5 },
		},
		auth: { mode: 'apiKey', cred: CREDENTIALS.decoy },
	}),
	workflow({
		name: 'case54 auth - a credential mode with nothing selected fails before spawning',
		notes:
			'Authentication=apiKey with no credential on the node. EXPECT: red, message "No credential ' +
			'selected", and no CLI process — the node must not quietly fall back to the host account it ' +
			'was pointed away from.',
		claude: { prompt: FAST_PROMPT, timeout: 120, effort: 'low' },
		auth: { mode: 'apiKey' },
	}),
);

// ---------------------------------------------------------------------------------------------
// chat-model cases (60-64): an AI Agent cluster with the Claude Code Chat Model on its
// ai_languageModel port. These are the first non-`main` connections this rig emits. The FINAL
// Agent node is named 'Claude Code Agent' so run-cases.mjs's /^Claude Code/ key pick reads ITS
// output; every other cluster node deliberately avoids that prefix. Auth: the cluster runs in
// host mode — the container env carries the operator's token — except case63's decoy credential.
function agentWorkflow({
	name,
	notes,
	prompts, // one Agent node per prompt, chained main->main; the LAST one is asserted on
	modelOptions = {},
	auth,
	tool, // { nodeName, toolName, description, jsCode }
	memoryKey, // a fixed custom session key, shared by every Agent in the workflow
	outputParserSchema, // JSON schema string -> Require Specific Output Format on the final Agent
	modelSessionId, // resume this Claude session (run-cases patches the real id in — see case65b)
	memorySource, // explicit Conversation Memory value; omitted means the `auto` default
	taskTool, // { nodeName, toolDescription, projectPath, options } -> the dedicated claudeCodeTaskTool
	usageTool, // { nodeName, toolDescription } -> the dedicated claudeCodePlanUsageTool
	twoItems = false, // a two-item Code node between the trigger and the Agent
}) {
	const nodes = [
		{
			parameters: {},
			id: nextId(),
			name: 'When clicking Execute',
			type: 'n8n-nodes-base.manualTrigger',
			typeVersion: 1,
			position: [0, 0],
		},
	];
	const connections = {};
	const link = (from, type, to) => {
		connections[from] ??= {};
		connections[from][type] ??= [[]];
		connections[from][type][0].push({ node: to, type, index: 0 });
	};

	if (twoItems) {
		// The trigger feeds the splitter, which feeds the Agent.
		connections['When clicking Execute'] = {
			main: [[{ node: 'Two items', type: 'main', index: 0 }]],
		};
		nodes.push({
			parameters: { jsCode: 'return [{ json: { n: 1 } }, { json: { n: 2 } }];' },
			id: nextId(),
			name: 'Two items',
			type: 'n8n-nodes-base.code',
			typeVersion: 2,
			position: [110, 0],
		});
	}

	const agentNames = prompts.map((_, i) =>
		i === prompts.length - 1 ? 'Claude Code Agent' : `Agent step ${i + 1}`,
	);
	prompts.forEach((text, i) => {
		nodes.push({
			parameters: {
				promptType: 'define',
				text,
				...(outputParserSchema && i === prompts.length - 1 ? { hasOutputParser: true } : {}),
				options: {},
			},
			id: nextId(),
			name: agentNames[i],
			type: '@n8n/n8n-nodes-langchain.agent',
			typeVersion: 3,
			position: [220 + i * 260, 0],
		});
		link(
			i === 0 ? (twoItems ? 'Two items' : 'When clicking Execute') : agentNames[i - 1],
			'main',
			agentNames[i],
		);
	});

	// Learned the hard way (first case65 attempt): a sub-node's output is NOT on the `main`
	// chain, so no expression — from another sub-node or from a main node — can read it
	// (`$('CC Model A').first()` fails with "No data found from `main` input"). The session id
	// must round-trip OUTSIDE the execution, exactly like a real caller or a Data Table does;
	// run-cases.mjs patches it into `modelSessionId` between executions, the case08 pattern.
	nodes.push({
		parameters: {
			model: 'claude-sonnet-5',
			projectPath: '',
			options: { effort: 'low', debug: true, ...modelOptions },
			...(auth ? { authSource: auth.mode } : {}),
			...(modelSessionId ? { sessionId: modelSessionId } : {}),
			...(memorySource ? { memorySource } : {}),
		},
		id: nextId(),
		// NOT 'Claude Code…': run-cases.mjs must keep reading the Agent's output, not the model's.
		name: 'CC Chat Model',
		type: '@joaoveiga/n8n-nodes-claudecode.claudeCodeChatModel',
		typeVersion: 1,
		position: [220, 220],
		...(auth?.cred
			? { credentials: { [auth.cred.type]: { id: auth.cred.id, name: auth.cred.name } } }
			: {}),
	});
	for (const agent of agentNames) link('CC Chat Model', 'ai_languageModel', agent);

	if (tool) {
		nodes.push({
			parameters: {
				name: tool.toolName,
				description: tool.description,
				language: 'javaScript',
				jsCode: tool.jsCode,
				specifyInputSchema: false,
			},
			id: nextId(),
			name: tool.nodeName,
			type: '@n8n/n8n-nodes-langchain.toolCode',
			typeVersion: 1.2,
			position: [480, 220],
		});
		for (const agent of agentNames) link(tool.nodeName, 'ai_tool', agent);
	}

	if (taskTool) {
		nodes.push({
			parameters: {
				toolDescription: taskTool.toolDescription,
				model: 'claude-sonnet-5',
				projectPath: taskTool.projectPath ?? '',
				options: { effort: 'low', debug: true, ...(taskTool.options ?? {}) },
			},
			id: nextId(),
			name: taskTool.nodeName,
			type: '@joaoveiga/n8n-nodes-claudecode.claudeCodeTaskTool',
			typeVersion: 1,
			position: [480, 380],
		});
		for (const agent of agentNames) link(taskTool.nodeName, 'ai_tool', agent);
	}

	if (usageTool) {
		nodes.push({
			parameters: {
				toolDescription: usageTool.toolDescription,
				// probeIfUnavailable is not optional here, it is the point: the container
				// authenticates with a CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, which is
				// inference-only by design — the usage endpoint refuses it and the honest answer is
				// "no windows". The probe reads them off the rate-limit response headers instead.
				// Without it this case asserts nothing about the tool (measured: first case67 red
				// returned NO_WINDOWS, which was CORRECT behaviour and a wrong test).
				options: { debug: true, probeIfUnavailable: true, ...(usageTool.options ?? {}) },
			},
			id: nextId(),
			name: usageTool.nodeName,
			type: '@joaoveiga/n8n-nodes-claudecode.claudeCodePlanUsageTool',
			typeVersion: 1,
			position: [700, 380],
		});
		for (const agent of agentNames) link(usageTool.nodeName, 'ai_tool', agent);
	}

	if (memoryKey) {
		nodes.push({
			parameters: { sessionIdType: 'customKey', sessionKey: memoryKey, contextWindowLength: 10 },
			id: nextId(),
			name: 'Window Memory',
			type: '@n8n/n8n-nodes-langchain.memoryBufferWindow',
			typeVersion: 1.3,
			position: [700, 220],
		});
		for (const agent of agentNames) link('Window Memory', 'ai_memory', agent);
	}

	if (outputParserSchema) {
		nodes.push({
			// schemaType/inputSchema, NOT jsonSchema: that param exists only up to typeVersion 1.1,
			// and n8n strips a parameter whose display condition is not met — so on 1.2 a jsonSchema
			// value silently gives way to the node's default state/cities example. Case64 failed on
			// exactly that before this comment existed.
			parameters: { schemaType: 'manual', inputSchema: outputParserSchema },
			id: nextId(),
			name: 'Structured Parser',
			type: '@n8n/n8n-nodes-langchain.outputParserStructured',
			typeVersion: 1.2,
			position: [920, 220],
		});
		link('Structured Parser', 'ai_outputParser', agentNames[agentNames.length - 1]);
	}

	return {
		id: stableId(name),
		name,
		nodes,
		connections,
		settings: { executionOrder: 'v1' },
		active: false,
		pinData: {},
		meta: { testCaseNotes: notes },
	};
}

cases.push(
	agentWorkflow({
		name: 'case60 chat-model - the Agent accepts the model and gets an answer',
		notes:
			'AI Agent + Claude Code Chat Model, no tools, no memory. EXPECT: success, output contains ' +
			'pong. This is the two-copies-of-@langchain/core proof (spec K1/S1) and the duck-typed ' +
			'gate proof (F-01) in one run.',
		prompts: ['Reply with exactly the word: pong. Nothing else.'],
		modelOptions: { timeout: 120, maxTurns: 5 },
	}),
	agentWorkflow({
		name: 'case61 chat-model - an Agent tool runs inside Claude Code and its value comes back',
		notes:
			'A Code Tool returning 73194, a number the model cannot guess. EXPECT: success, output ' +
			'contains 73194 — proof the mcp__n8n__ bridge executed the connected sub-node (F-05).',
		prompts: [
			'Call the available tool to get the secret number, then reply with only that number.',
		],
		modelOptions: { timeout: 180, maxTurns: 10 },
		tool: {
			nodeName: 'Secret Number Tool',
			toolName: 'secret_number',
			description: 'Returns the secret number. Input is ignored.',
			jsCode: 'return 73194;',
		},
	}),
	agentWorkflow({
		name: 'case62 chat-model - memory carries the first answer into the second call',
		notes:
			'Two Agents sharing one Simple Memory (custom key) in ONE execution — the CLI spawns a ' +
			'fresh n8n process per run, so cross-execution memory is untestable here. EXPECT: the ' +
			'second output contains chartreuse.',
		prompts: [
			'Remember this: my favourite colour is chartreuse. Reply with exactly: OK',
			'What is my favourite colour? Reply with only the colour name.',
		],
		modelOptions: { timeout: 150, maxTurns: 5 },
		memoryKey: 'e2e-case62-memory',
	}),
	agentWorkflow({
		name: 'case63 chat-model - an invalid credential fails the Agent, not the host fallback',
		notes:
			'The decoy API key on the chat model, container logged in via env. EXPECT: red, ' +
			'authentication_failed counted in the raw log, no pong anywhere — same proof shape as ' +
			'case53. The model times out (the CLI retries 401s), so the timeout is kept short.',
		prompts: ['Reply with exactly the word: pong. Nothing else.'],
		modelOptions: { timeout: 25, wrapUpGraceSeconds: 5, maxTurns: 3 },
		auth: { mode: 'apiKey', cred: CREDENTIALS.decoy },
	}),
	agentWorkflow({
		name: 'case65a chat-model session - the first call opens the session',
		notes:
			'First half of the round-trip continuity proof. EXPECT: success, answer OK; run-cases ' +
			'captures the chat model-s sessionId from its run data for case65b.',
		prompts: ['Memorize: a fruta secreta é abacaxi. Responda exatamente: OK'],
		modelOptions: { timeout: 150, maxTurns: 5 },
	}),
	agentWorkflow({
		name: 'case65b chat-model session - a SECOND EXECUTION resumes it',
		notes:
			'NO Memory node, separate execution: only the resumed Claude session can carry the ' +
			'fruit. run-cases patches the real session id in before running (case08 pattern) — an ' +
			'expression cannot do it, because sub-node outputs are not on the main chain. EXPECT: ' +
			'the answer names abacaxi.',
		prompts: ['Qual é a fruta secreta? Responda somente o nome da fruta.'],
		modelOptions: { timeout: 150, maxTurns: 5 },
		modelSessionId: 'PASTE_SESSION_FROM_CASE65A',
	}),
	agentWorkflow({
		name: 'case66 dedicated task tool - Claude Code as a real ai_tool sub-node',
		notes:
			'The purpose-built claudeCodeTaskTool (fixed {task} schema, no $fromAI hand-wiring). The ' +
			'fixture has exactly six .ts files under /workspace/src, so the answer proves the inner ' +
			'agent actually ran in the project. EXPECT: success, output contains 6.',
		prompts: [
			// Two naming traps, both measured on this case:
			//   1. "the task tool" made the model call Claude Code's OWN built-in `Task` tool (the
			//      subagent launcher) instead of ours — the log showed task_started/task_progress
			//      and never touched mcp__n8n__*. The bridged tool is named explicitly instead, and
			//      `Task` is disallowed on the outer model so it cannot shadow.
			//   2. The n8n image is Alpine with no bash at all (/bin/sh is busybox), so Claude
			//      Code's Bash answers "No suitable shell found" — the first run burned 165s on it.
			// Anchored format, like case68: a bare `6` in free text is a guessable number, and the
			// assertion could pass on a model that never called the tool.
			'Call the Project_Inspector tool with the task: "count how many .ts files exist under /workspace/src using Glob, and reply with just the number". Then reply with exactly: FILES=<n>',
		],
		modelOptions: { timeout: 240, maxTurns: 8, disallowedTools: ['Task', 'Bash'] },
		taskTool: {
			nodeName: 'Project Inspector',
			toolDescription:
				'Runs a coding or file task with Claude Code inside the /workspace project. Input: one clear task in natural language. Returns the result as text.',
			projectPath: '/workspace',
			options: {
				timeout: 150,
				maxTurns: 10,
				// Bash is disallowed rather than merely discouraged: no shell exists in this image.
				disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
			},
		},
	}),
	agentWorkflow({
		name: 'case67 dedicated usage tool - zero-argument plan read via ai_tool',
		notes:
			'The purpose-built claudeCodePlanUsageTool: zero-argument schema (the exec-88 regression ' +
			'shape), reads plan windows in-process. EXPECT: success and a utilisation percentage in ' +
			'the answer — and never the tool-level "Could not read" failure text.',
		prompts: [
			'Use the plan usage tool, then reply with only the five_hour window utilization as a number (no % sign). If the tool reports no windows, reply exactly: NO_WINDOWS',
		],
		modelOptions: { timeout: 180, maxTurns: 6 },
		usageTool: {
			nodeName: 'Plan Usage',
			toolDescription:
				'Reads the current Claude plan usage: percentage used and reset time per rate-limit window. Takes no input. Returns a JSON report.',
		},
	}),
	agentWorkflow({
		name: 'case71 usage reporting - a sub-node calls the collector workflow itself',
		notes:
			'The Chat Model and the Task Tool both report to case71collector. EXPECT: success, and ' +
			'TWO executions of the collector — one per sub-node call — each carrying process_name, ' +
			'run_key and the same metrics/diagnostics shape the main node emits. This is the only ' +
			'proof that executeWorkflow works from a supply context in the middle of an agent loop.',
		prompts: [
			'Call the Project_Inspector tool with the task "reply with just the word ok", then reply with exactly: done',
		],
		modelOptions: {
			timeout: 180,
			maxTurns: 8,
			disallowedTools: ['Task', 'Bash'],
			reportUsageTo: 'case71collector0',
			processName: 'e2e-chat-model',
		},
		taskTool: {
			nodeName: 'Project Inspector',
			toolDescription:
				'Runs a task with Claude Code. Input: one clear task in natural language. Returns text.',
			projectPath: '/workspace',
			options: {
				timeout: 120,
				maxTurns: 5,
				disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
				reportUsageTo: 'case71collector0',
				processName: 'e2e-task-tool',
			},
		},
	}),
	agentWorkflow({
		name: 'case72 usage reporting - TWO items must not share a run_key',
		notes:
			'A Code node emits two items into the Agent. EXPECT: two reports whose run_keys differ. ' +
			'This measures what supplyData\u0027s lifetime actually is — the counter alone starts at 1 ' +
			'per supplied instance, so if n8n supplies one per item the keys collide unless itemIndex ' +
			'is in them, and a collector upserting on the key would silently drop the first item.',
		prompts: ['Reply with exactly the word: pong. Nothing else.'],
		modelOptions: {
			timeout: 150,
			maxTurns: 3,
			reportUsageTo: 'case71collector0',
			processName: 'e2e-two-items',
		},
		twoItems: true,
	}),
	agentWorkflow({
		name: 'case69 memory mode - the EXPLICIT choice ignores a Session ID and uses the Memory node',
		notes:
			'Conversation Memory = n8n Memory Sub-Node, WITH a Session ID also set on the node. Only a ' +
			'real n8n can prove this: the field is hidden by displayOptions in this mode and n8n ' +
			'STRIPS parameters whose display condition fails, which is the same mechanism that bit ' +
			'authSource and binaryProperties. EXPECT: the second answer recalls the colour (memory ' +
			'works) AND the model reports session_state "new" — the session path was not taken.',
		prompts: [
			'Remember: minha cor favorita é verde-limão. Responda exatamente: OK',
			'Qual é a minha cor favorita? Responda somente o nome da cor.',
		],
		modelOptions: { timeout: 150, maxTurns: 5 },
		memoryKey: 'e2e-case69-memory',
		memorySource: 'memory',
		modelSessionId: 'e2e-case69-should-be-ignored',
	}),
	agentWorkflow({
		name: 'case70 session mode - the EXPLICIT choice resumes and reports it',
		notes:
			'Conversation Memory = Claude Code Session, with a Memory node ALSO connected. EXPECT: ' +
			'success and session_state "created" — the memory history is not re-sent, the session is.',
		prompts: ['Reply with exactly the word: pong. Nothing else.'],
		modelOptions: { timeout: 150, maxTurns: 5 },
		memoryKey: 'e2e-case70-memory',
		memorySource: 'session',
		modelSessionId: 'e2e-case70-conversation-key',
	}),
	agentWorkflow({
		name: 'case68 both dedicated tools in ONE turn - task + usage',
		notes:
			'One question that cannot be answered without BOTH tools: the plan number comes only ' +
			'from the usage tool, the file count only from the task tool. EXPECT: success, output ' +
			'matching FILES=6 and USAGE=<number>. Proves two bridged tools coexist in one session ' +
			'and that a zero-argument tool and a one-argument tool are both callable in the same run.',
		prompts: [
			'Answer with exactly one line in this format and nothing else: FILES=<n> USAGE=<n>. ' +
				'Get <n> for FILES by calling the Project_Inspector tool with the task "count how many ' +
				'.ts files exist under /workspace/src using Glob and reply with just the number". Get ' +
				'<n> for USAGE by calling the Plan_Usage tool and reading the five_hour window ' +
				'utilization as a whole number.',
		],
		modelOptions: { timeout: 300, maxTurns: 12, disallowedTools: ['Task', 'Bash'] },
		taskTool: {
			nodeName: 'Project Inspector',
			toolDescription:
				'Runs a coding or file task with Claude Code inside the /workspace project. Input: one clear task in natural language. Returns the result as text.',
			projectPath: '/workspace',
			options: {
				timeout: 150,
				maxTurns: 10,
				disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
			},
		},
		usageTool: {
			nodeName: 'Plan Usage',
			toolDescription:
				'Reads the current Claude plan usage: percentage used and reset time per rate-limit window. Takes no input. Returns a JSON report.',
		},
	}),
	agentWorkflow({
		name: 'case65c chat-model session - a stable KEY creates the session (no storage)',
		notes:
			'Session ID holds a literal conversation key, not a UUID. The node hashes it to a ' +
			'deterministic id; the resume attempt finds nothing and the session is created under ' +
			'that id. EXPECT: success, answer OK.',
		prompts: ['Memorize: a fruta secreta é jabuticaba. Responda exatamente: OK'],
		modelOptions: { timeout: 150, maxTurns: 5 },
		modelSessionId: 'e2e-case65cd-conversation-key',
	}),
	agentWorkflow({
		name: 'case65d chat-model session - the SAME KEY resumes it in a new execution',
		notes:
			'Same literal key as case65c, separate execution, NO Memory node and NO patching: the ' +
			'deterministic hash alone finds the session. EXPECT: the answer names jabuticaba.',
		prompts: ['Qual é a fruta secreta? Responda somente o nome da fruta.'],
		modelOptions: { timeout: 150, maxTurns: 5 },
		modelSessionId: 'e2e-case65cd-conversation-key',
	}),
	agentWorkflow({
		name: 'case64 chat-model - Require Specific Output Format returns the schema-d object',
		notes:
			'Structured Output Parser on the final Agent. EXPECT: success and output.answer names ' +
			'blue — proof of the R16 format_final_json_response passthrough.',
		prompts: [
			'What colour is a clear daytime sky? Answer briefly and set confidence to 1.',
		],
		modelOptions: { timeout: 150, maxTurns: 5 },
		outputParserSchema:
			'{"type":"object","properties":{"answer":{"type":"string"},"confidence":{"type":"number"}},"required":["answer"]}',
	}),
);

// The collector a reporting case points at. Deliberately a single trigger node: what is being
// proven is that a SUB-NODE can call a workflow at all (executeWorkflow is inherited by the
// supply context but had never been exercised mid-agent-loop), and its own execution record —
// with the payload the sub-node sent — is the evidence.
cases.push({
	id: 'case71collector0',
	name: 'collector71 usage collector (called BY a sub-node)',
	nodes: [
		{
			// `passthrough` accepts whatever the caller sends. With the default (declare fields)
			// the trigger refuses with "At least 1 field is required" and the report is lost —
			// measured on case71's second run.
			parameters: { inputSource: 'passthrough' },
			id: nextId(),
			name: 'When Executed by Another Workflow',
			type: 'n8n-nodes-base.executeWorkflowTrigger',
			typeVersion: 1.1,
			position: [0, 0],
		},
	],
	connections: {},
	settings: { executionOrder: 'v1' },
	// MEASURED: a sub-node's executeWorkflow fails with "Workflow is not active and cannot be
	// executed" against an inactive target. n8n-up activates this one after importing.
	active: true,
	pinData: {},
	meta: {
		testCaseNotes:
			'Target of case71. Named without a "case" prefix so run-cases does not execute it directly.',
	},
});

let n = 0;
for (const wf of cases) {
	const file = `${String(++n).padStart(2, '0')}-${wf.name.split(' ')[0]}.json`;
	writeFileSync(OUT + file, JSON.stringify(wf, null, 2));
	console.log(`${file}  ${wf.name}`);
}
console.log(`\n${cases.length} workflows written to ${OUT}`);
console.log('\nNot covered by an importable workflow:');
console.log('  case07  manual cancel mid-run  - press Stop during case01, no wrap-up should happen');
console.log('  case10  Error Workflow         - needs an Error Trigger workflow set in case01 settings');
