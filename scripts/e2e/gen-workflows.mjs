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

function workflow({ name, notes, claude, outputFormat = 'structured', onError, readFields = [], version = 1.1 }) {
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
			},
			id: claudeId,
			name: 'Claude Code',
			type: '@joaoveiga/n8n-nodes-claudecode.claudeCode',
			typeVersion: version,
			position: [220, 0],
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
	attachAllBinaries = false,
	additionalOptions = {},
	onError,
	readFields = [],
	timeout = 120,
	// Empty means the full built-in tool set. A non-empty list is what makes the stagedAttachments
	// applier's Read-injection branch reachable at all — see case45.
	restrictTools = [],
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
		version: 1.2,
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
	claude.parameters.attachAllBinaries = attachAllBinaries;
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
		attachAllBinaries: true,
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
