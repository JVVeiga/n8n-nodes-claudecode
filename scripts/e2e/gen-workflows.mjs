// Generates one n8n workflow per manual test case from SPEC.md, ready to import with
// `n8n import:workflow --separate --input=<dir>`. Each is a manual trigger -> Claude Code node,
// plus a Set node reading the payload fields the case is about, so the assertion is visible in the
// UI without digging through JSON.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

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
