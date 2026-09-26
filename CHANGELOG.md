## [2.3.1](https://github.com/JVVeiga/n8n-nodes-claudecode/compare/v2.3.0...v2.3.1) (2026-09-26)

What the canvas shows for the new nodes. Nothing a node emits changes, so no typeVersion moves.

- **Claude Code Subagent** shows its **Name** and model as the subtitle (`alpha · inherit`). The
  Agent delegates by that Name, not by the node's title, and the two could differ unseen.
- **Claude Code Agent** shows the model plus the output mode and Verification when they apply
  (`claude-sonnet-5 · Schema · Verify`), and warns under Subagent Orchestration that in Auto a
  connected subagent may never run.
- **Code Review Kit** has its own icon. It calls no model, and the Claude icon it shared suggested
  it did. The Subagent has its own variant of the Claude icon.

## [2.3.0](https://github.com/JVVeiga/n8n-nodes-claudecode/compare/v2.2.0...v2.3.0) (2026-09-25)

Three new nodes, three fixes to the existing ones, and new typeVersions for the fix that changes an
answer. A minor: a stored workflow keeps its typeVersion and emits what it did, and the 48 golden
fixtures are byte-identical and unregenerated. The code the new nodes share with the old ones (the
tool bridge and the session helpers, moved to `shared/`; three new `config.ts` appliers and an
Instruction Files input to the System Prompt one; five optional diagnostics fields) is a no-op for
them.

### Claude Code Agent

A root node that runs Claude Code over each item and takes three AI inputs: **Tools** (`ai_tool`),
**Subagents** (`ai_agent`) and a **Parser** (`ai_outputParser`). It keeps the Claude Code node's
run settings and its 1.2 output envelope, and adds:

- **n8n tools inside the run.** Code Tool, Call Workflow Tool, a node used as a tool and MCP Client
  Tool all reach Claude Code as `mcp__n8n__<tool>`; an MCP toolkit is flattened, and each tool node
  logs its calls. `diagnostics.bridgedTools` lists them.
- **Structured output.** Output Mode JSON Schema or Output Parser emits the object as `structured`.
  A parser's `{ output: … }` wrapper is removed, so both modes give the same shape. A run succeeds
  only when the object is present: the retries-exhausted result and the prose give-up that the CLI
  reports as a success both fail the item with `errorType: 'structured_output'`, metrics included.
- **Verification.** An option that resumes the session in a second run, tries to refute the items
  at a dot path (optionally only those with a given field value), and removes the ones it refutes.
  The node applies the verdict. A failed verification drops nothing. `verification.costUsd` is the
  second run's own share, and `metrics` counts both runs once.
- **Instruction Files**, appended to the system prompt after System Prompt. A missing file is
  listed in `diagnostics.instructions.missing`; a path outside Project Path fails the item.
- **Sessions by key.** Session Resume with any stable key, hashed into a deterministic session id:
  created on first use, resumed after. `diagnostics.sessionState` says which.
- **Subagent Orchestration: Required**, which asks Claude to delegate to every connected subagent.
  `diagnostics.subagents` reports each one's delegations, tokens, tool uses and duration, so a
  subagent that never ran shows `invocations: 0`.
- **Report Usage to Workflow**, the sub-nodes' collector call, on success, failure and timeout.
- **claude.ai connectors off by default.** A full claude.ai login otherwise connects the account's
  cloud connectors into every run (about 320k extra tokens in one measured run). **Allow Claude.ai
  Connectors** turns them back on.
- **The answer is the last result.** When subagents run in the background the CLI writes several
  results, the first one an interim "let me wait". The Agent reads the last.

### Claude Code Subagent

A sub-node with an `ai_agent` output that defines one subagent for the Agent: Name, When to Use,
Instructions, Model (inherit by default), and under Options Effort, Max Turns, an allowlist of
built-in tools plus extra names (a connected tool is `mcp__n8n__<tool>`), Disallowed Tools and Skip
Project CLAUDE.md. The editor offers it only on the Agent's Subagents input. Each delegation is
logged on the Subagent node with its prompt, summary and usage.

### Code Review Kit

A node with no model and four operations over a git clone: **Diff Context** (merge base, files,
the added line numbers per file, optionally the `-U0` patch), **Validate Anchors** (findings on an
added line kept, the rest moved aside with a reason), **Fingerprint** (sha256 of path, type and the
normalized code around the line, read at a ref, stable under insertions above it) and **Dedupe**
(new, repeated and resolved against a previous run). git runs through `execFile` with validated
refs and no shell. Field names are parameters.

### Template

`workflow-templates/claude-code-review-team.json`: Diff Context → an Agent with three reviewer
subagents (correctness, performance and SQL, conventions), a JSON Schema review, Instruction Files
from `.review/rules.md` and Verification on blockers → Validate Anchors → Fingerprint.

### New typeVersions: Claude Code 1.4, Chat Model 1.1, Task Tool 1.1

When Claude sends a subagent to the background, the CLI writes a result for the turn that launched
it ("I've launched the agent, I'll wait") and another once the subagent reports back. The Claude Code
node (1.2/1.3 envelope), the Chat Model and the Task Tool answered from the first, so the item could
carry that interim text, and their graceful timeout took the interim result as the end of the run.

- **Claude Code 1.4** (the new default): `result`, `success`, `errorText` and the diagnostics come
  from the final result, and the run stays open, and the graceful timeout keeps its wrap-up, while a
  subagent is still out. 1 to 1.3 emit what they did, the Unified envelope override included.
- **Chat Model 1.1** and **Task Tool 1.1** (the new defaults): the same, for the reply and for the
  usage report. Version 1 is unchanged.

A node keeps the version it was created with, so only nodes added from now on get it. On runs with
several results `metrics.duration_ms` and `num_turns` still cover the last segment only; the cost is
cumulative and right.

### Fixes

- **`diagnostics.subagentToolUses` counts subagent delegations again.** The CLI delegates through a
  tool named `Agent` while still listing `Task` in `init`, so the Claude Code node reported 0 for
  every run that used subagents. Both names are counted now, on every typeVersion: a wrong number
  corrected, with the field and its shape unchanged.
- **A number where a text parameter is set by an expression no longer crashes the node.** n8n
  coerces only parameters that declare `validateType`, so `{{ $json.ticketId }}` resolving to 4711
  made the Chat Model's Session ID fail with `.trim is not a function`. The same crash reached
  Claude Code's Session ID, Prompt, Project Path, Binary Properties and executable path, the Task
  Tool's description and process name, and the Usage node and tool. Each is read as text now.

### Known

A behaviour of the **existing** nodes, found while building the Agent and documented here rather
than fixed in this release, because fixing it changes what existing runs emit:

- **Cumulative cost on resume.** A run that resumes a session (the Claude Code node's Continue, the
  Chat Model's Session ID, the Agent's Resume) reports a `total_cost_usd` and `modelUsage` that
  include every earlier run of that session. A collector that sums cost per execution counts those
  runs again. `num_turns`, `duration_ms` and `usage` are per run.

## [2.2.0](https://github.com/JVVeiga/n8n-nodes-claudecode/compare/v2.1.0...v2.2.0) (2026-09-22)

Additive. No typeVersion moved, the 48 golden fixtures are byte-identical and unregenerated, and
every stored workflow keeps the model it selected.

### Claude Opus 5.5

**Claude Opus 5.5** (`claude-opus-5-5`) is now in the model list, ahead of Opus 5. It has a 1M
context window natively, and the CLI prices it at $4/$20 per Mtok. Like Fable 5.1 it is one new
entry, so it appears in six places: **Model** and **Fallback Model** on the main node, the
**Chat Model** sub-node, and the **Task Tool**.

**Opus 5 stays.** Removing it would empty the dropdown for a workflow that had selected it, so
only its description changed.

The **Opus (Latest Alias)** option did not need to change: from CLI 2.1.280 `opus` resolves to
Opus 5.5 on first-party auth, Bedrock, Vertex and Mantle. On Foundry and gateways it still resolves
to an older Opus. Pick the pinned ID if you need 5.5 everywhere. The default is still `sonnet`.

The ID carries no `[1m]` suffix. The CLI's model table marks Opus 5.5 `native_1m`. It also accepts
the suffix, but in 2.1.280 the only effect is "(1M context)" in the display name.

### The SDK floor moved to 0.3.280

`@anthropic-ai/claude-agent-sdk` `^0.3.257` → `^0.3.280`, the first release whose bundled CLI
(2.1.280) recognizes `claude-opus-5-5`. This was found by bisecting the published binaries:
0.3.278 and earlier do not contain the ID.

The reason is the same as for Fable 5.1. An unrecognized ID still runs, but the CLI assumes a 200k
window and auto-compacts a 1M model early. If you set **Claude Code Executable Path**, that binary
must be 2.1.280 or newer.

## [2.1.0](https://github.com/JVVeiga/n8n-nodes-claudecode/compare/v2.0.0...v2.1.0) (2026-09-01)

Additive. No typeVersion moved, the 48 golden fixtures are byte-identical and unregenerated, and
every stored workflow keeps the model it selected.

### Claude Fable 5.1

Anthropic released **Claude Fable 5.1** (`claude-fable-5-1`) on 2026-09-01 — 1M context, and the
default Fable model from Claude Code 2.1.257 onward. It is one new entry in the model list, which
is why it shows up in six places at once: **Model** and **Fallback Model** on the main node, the
**Chat Model** sub-node, and the **Task Tool**. The two Usage nodes have no model selector — they
read the plan rather than run a turn.

**Fable 5 stays.** It is still in Anthropic's model table and is not deprecated, so removing it
would empty the dropdown for a workflow that had selected it. Only its description changed, since
it is no longer the most capable model on offer.

The default is still `sonnet` everywhere. Fable is an explicit choice at $10/$50 per Mtok.

No `fable` alias was added alongside `sonnet`/`opus`/`haiku`. In Claude apps gateway sessions
`fable` still resolves to Fable **5**, because gateways not yet configured for 5.1 reject it — an
option that means a different model depending on where n8n runs is worse than no option.

### The SDK floor moved to 0.3.257

`@anthropic-ai/claude-agent-sdk` `^0.3.202` → `^0.3.257`, which is the first release whose bundled
CLI (2.1.257) recognizes `claude-fable-5-1`.

This is not housekeeping. `Options.model` is a plain string rather than a union, and the CLI
forwards an ID it does not know straight to the API — so the model *runs* on an older CLI, and
answers. What breaks is the context window: an unrecognized ID is assumed to be 200k, and a
1M-context model gets auto-compacted at a fifth of its window, with only a line on stderr to say
so. After the bump the same run reports `contextWindow: 1000000` and
`canonicalModel: claude-fable-5-1`.

If you point the node at your own binary through **Claude Code Executable Path**, that binary is
the one that has to be 2.1.257 or newer — the floor here only governs the bundled CLI.

## [2.0.0](https://github.com/JVVeiga/n8n-nodes-claudecode/compare/v1.1.0...v2.0.0) (2026-08-31)

**A major, and only for one reason**: the auto-generated tool variants are gone (see BREAKING
below). Everything else is additive — no typeVersion moved, the two existing nodes emit exactly
what they emitted, and the 48 golden fixtures are byte-identical and unregenerated.

### Claude Code Chat Model — plug Claude Code into n8n's AI Agent

A Chat Model sub-node (`ai_languageModel` output) the AI Agent accepts like any other chat model,
with the same per-execution Authentication (Host / API Key / OAuth Token) as the other two nodes.
What makes it different from the native Anthropic Chat Model is that every Agent call runs a full
Claude Code session: the project's `CLAUDE.md`, MCP servers, and Claude Code's own tools (Bash,
Read, Glob…) are all in play, governed by the same Effort / Thinking / Restrict Tools / Max
Budget / Timeout knobs as the main node.

**The Agent's tools run inside Claude Code.** Tools connected to the Agent are handed over as one
in-process MCP server (`mcp__n8n__<tool>`) and executed by Claude Code during its own loop — each
Tool sub-node still logs its runs. The Agent therefore sees a single model turn per call. Two
Agent features do not apply and say so in the docs: human-in-the-loop tool approval and Return
Intermediate Steps. "Require Specific Output Format" **is** supported — the model returns the
`format_final_json_response` call the Agent's parser expects.

**Memory and streaming work.** Connected memory arrives as chat history and is flattened into the
prompt; chat streaming reaches the Chat Trigger token by token.

**Conversation Memory picks the mechanism.** A selector on the node: *Auto* (the pre-selector
behaviour — Session ID decides), *Claude Code Session*, or *n8n Memory Sub-Node*. An explicit
Session choice with no Session ID fails the node rather than running stateless; Memory mode hides
the Session ID field and ignores whatever it holds.

**Real multi-turn via Session ID.** Set the node's **Session ID** field to any stable
conversation key (a Discord/WhatsApp/user ID, straight off the webhook). The key is hashed into a
deterministic Claude Code session ID: created on the conversation's first message, resumed on
every next one — prior turns and tool results included, no Memory node and **no storage
anywhere**. A raw session UUID also works (client round-trip style).
`response_metadata.session_state` reports `created`/`resumed`/`new` per call; a session that can
neither be resumed nor created fails with a clear error instead of a fabricated answer.

**Honest cost note.** Each Agent call spawns the Claude Code CLI (~2–5 s) and carries its system
prompt. This is not a cheap chat model; it is Claude Code with an Agent plugged into it.

### BREAKING: the auto-generated tool variants are gone

`usableAsTool` was removed from **Claude Code** and **Claude Code Usage**, so n8n no longer
synthesizes "Claude Code Tool" / "Claude Code Usage Tool" wrappers from them. Those wrappers were
duplicates in the editor's tool picker and, for the main node, structurally broken: the Agent was
offered a **zero-argument** schema unless you hand-wrote `$fromAI()` into the Prompt field, so the
model had no way to pass a task.

**Migration**: replace an auto-wrap node on an Agent's Tool port with the dedicated node below —
**Claude Code Task Tool** or **Claude Code Usage Tool** — and set its Tool Description. Nothing
else changes; the regular Claude Code and Claude Code Usage nodes are untouched on the main flow.

### Two purpose-built Agent tools

**Claude Code Task Tool** and **Claude Code Usage Tool** — real `ai_tool` sub-nodes that work
with ANY Agent chat model, native ones included. The Task tool has a fixed one-argument contract
(`task` in, result text out; failures return as text the model can react to); the Usage tool is
zero-argument and returns the plan report as JSON text. Both replace the auto-generated
`usableAsTool` wrappers as the supported path — those exposed every node parameter and, for the
main node, a zero-argument schema unless `$fromAI()` was hand-wired. The wrappers are gone — see
BREAKING above for the migration.

### Usage reporting from a sub-node

The main node puts `metrics` and `diagnostics` in its output; a sub-node has no output an
expression can read. The Chat Model and the Task Tool therefore offer **Report Usage to Workflow**
and **Process Name**: after every call they hand `{ process_name, run_key, caller_workflow_id,
caller_execution_id, node_name, metrics, diagnostics }` to the workflow you pick.

The metrics and diagnostics are the SAME objects the main node emits — pinned by a test that
compares them to the main node's own output builder — so a collector workflow written for the
main node ingests a sub-node's run unchanged.

`run_key` (`<executionId>:<node name>:<seq>`) identifies one call. It is deliberately not the
session id: a resumed conversation reuses that across executions, so a table keyed on it would
overwrite a conversation's history with its most recent message.

The Usage Tool does not offer this — it performs a plan read, with no session, turns or tokens to
report. Two n8n facts worth knowing before pointing a node at a collector: the collector must be
**published** (n8n 2.x resolves the published version; merely active is refused), and its trigger
must accept the payload (declare the fields, or use passthrough). A collector that fails costs you
a metric, never the run.

**Packaging.** `@langchain/core` and `zod` are peer dependencies by design: n8n resolves peers to
its own copies for community nodes, which keeps one copy of LangChain in play. The verified
contract and decisions live in the repo's spec notes.

## [1.1.0](https://github.com/JVVeiga/n8n-nodes-claudecode/compare/v1.0.0...v1.1.0) (2026-08-30)

Not a breaking release, and not a new typeVersion. Nothing an existing workflow emits or does
changes — the new parameter defaults to the behaviour every stored workflow already has, and the 48
golden fixtures are byte-identical and unregenerated. That is the evidence, not the argument.

### Authentication — one credential per execution, instead of one per instance

Both nodes authenticated exactly one way: whatever the n8n host was logged in as. One identity for
the whole instance — one bill, one set of plan limits, one account to rotate — so three workflows
could not run on three accounts, and a per-workflow key meant touching the container.

**Authentication** now picks per execution, on both nodes.

| Mode | Runs as | Credential |
|---|---|---|
| **Host** (default) | the account the n8n container is logged in as | none |
| **API Key** | an Anthropic API key, billed as API usage | *Claude Code API* |
| **OAuth Token** | a Claude Code OAuth token, billed against that account's Claude plan | *Claude Code OAuth Token API* |

**It genuinely overrides the host.** The credential reaches the Claude Code CLI through its
subprocess environment, and the CLI only falls back to the host's `~/.claude/.credentials.json` when
neither `ANTHROPIC_API_KEY` nor `CLAUDE_CODE_OAUTH_TOKEN` is set. The host login is never read,
written or refreshed for that execution.

**Every other auth variable is cleared first** — all seven the SDK recognises, including
`ANTHROPIC_AUTH_TOKEN` and the Bedrock, Vertex and Foundry keys. A container that exports
`ANTHROPIC_API_KEY` globally cannot leak it into a run you pointed at an OAuth token. Setting only
the chosen variable would have let that run *succeed* on the wrong account, which is the worst shape
the bug could take. Everything that is not authentication — `PATH`, `HOME`, proxy variables — passes
through untouched.

**A run that used a credential says so**, in `diagnostics.auth`. A host run has no such field at
all: it is added by a conditional spread, which is exactly what keeps the output of every existing
workflow unchanged own-property for own-property, and why this needed no new typeVersion.

**A selected credential that is empty fails the item.** It does not fall back to the host — running
on an account you explicitly pointed away from is worse than stopping.

### What is *not* per-credential

The credential changes **who pays and who is rate-limited**, not what the agent can do. `~/.claude`
stays the host's, so `settings.json`, MCP servers and plugins apply to every run whichever
credential it uses, and the **session store is shared**: `Continue` with no Session ID still
resolves "the most recent conversation in this directory" across every execution on the instance,
exactly as before. Set an explicit Session ID for concurrent runs.

### Two things that will bite you

**A rejected credential takes minutes to say so.** The CLI retries a 401 with backoff rather than
giving up. Measured: with the default 300s Timeout the run fails at ~184s with a clear
`Failed to authenticate. API Error: 401 API key is invalid.`; with a Timeout shorter than the retry
window your own timer fires first and the run reports *0 assistant turns* and an unknown cost,
naming nothing. A credentialed run that times out with no turns is a credential to check.

**The OAuth Token credential has no Test button.** Those tokens have no documented HTTP endpoint to
test against — a test built on a guess would put a red cross on working credentials. The API Key
credential has one. The first run is the test.

See [Authentication](README.md#authentication).

## [1.0.0](https://github.com/JVVeiga/n8n-nodes-claudecode/compare/v0.12.0...v1.0.0) (2026-08-29)

**Why 1.0.0.** `1.0.0` was reserved two releases ago for the first feature built *on* the refactored
architecture, as evidence the refactor helped. This is that feature, and the evidence held: six new
modules under `nodes/ClaudeCode/attachments/`, one entry in the `APPLIERS` table, one optional field
on `Diagnostics` — and not one line of `output/legacy.ts` touched, nor one of the 48 golden fixtures
moved. Adding a capability this size without disturbing what existing workflows emit is the thing
the refactor was for.

It is not a breaking release. Nothing an existing workflow emits or does changes; see below.

### Attachments — send the files already on the item

Binary data on the incoming n8n item can now go to Claude with the prompt: a Monday screenshot, a
CSV export, an HTML capture, a PDF. Fixing a bug needs the evidence, and the evidence arrives as
files — until now the node accepted one thing, a string, so everything else had to be flattened
upstream by hand, which loses images entirely and turns a 40 MB log into a choice between truncating
it and blowing the context.

| Parameter | Where | Default |
|---|---|---|
| **Attach All Binaries** | top level, under Project Path | `Auto` |
| **Binary Properties** | top level, only when Attach All is `Off` | `''` |
| **Allowed Extensions** | Additional Options | `[]` (no filter) |
| **Inline Text Size Limit (KB)** | Additional Options | `256` |
| **Max Attachment Size (MB)** | Additional Options | `50` |
| **Max Attachment Count** | Additional Options | `16` |

**Files reach the model directly.** `SDKUserMessage.message` is the Anthropic SDK's `MessageParam`,
so its `content` accepts `ContentBlockParam[]`: an image goes in as an image, a PDF as a PDF, a CSV
as a document. Vision works with no tool enabled and no filesystem involved. Images (PNG/JPEG/GIF/
WebP up to 5 MB), PDFs (up to 20 MB) and text under the inline limit take that route.

**Everything else is staged.** A file over one of those ceilings, or of a type no content block can
carry (`.xlsx`, `.zip`, `.heic`), is written to a temporary directory exposed to the agent via
`additionalDirectories`, and the prompt says what is there so the agent can `Read` it — or `grep` a
40 MB log rather than swallow it. That directory is removed when the item finishes: on success, on
error, and on a timeout.

**Allowed Extensions narrows what is considered at all** — a multi-select of 121 extensions, empty
by default. Select some and only those go; anything else is skipped and the run continues. It judges
the *derived* filename, so a binary with no filename is still matched on the extension its MIME type
implies, and it runs before the count and size checks, so a file you told it to ignore can never
trip **Max Attachment Count**.

**A skip is not a failure, and the difference is deliberate.** A property that is not on the item,
one over the size cap, or too many of them **fails that item** with a message naming the property —
those refuse something you asked for, and answering without the evidence would be worse than
stopping. The extension filter is you saying which types you want, so excluding the rest is
obedience. Every skip is still reported, because "ignore and continue" is the pattern that goes
wrong quietly.

When at least one attachment was sent or skipped, `diagnostics.attachments` reports the count of
what was **sent**, the total bytes, what was skipped and why, how each inlined file was sent, and
the staged directory and its files.

See [Attachments](README.md#attachments) for the routing table and the two things that will bite you.

### typeVersion 1.3, and why it exists

**Attach All Binaries** on `Auto` means *on* from 1.3 and *off* below it. A node keeps the version it
was created with, so a node you add now attaches by default while every workflow you already built
does not. Nothing else changed: 1.3 emits exactly what 1.2 emits.

That indirection is not decoration. A schema default cannot be made version-aware — n8n's `Workflow`
constructor writes every schema default into `node.parameters` *before* execution
(`NodeHelpers.getNodeParameters`), so a parameter absent from a stored workflow still arrives
carrying the schema's value. An earlier draft used a plain boolean defaulting to `true`, reasoning
that the run-time lookup would fall through to the node's own fallback. It does not, and the E2E case
written to prove that claim disproved it: a workflow with no such key attached all three of its
files. Left alone it would have started attaching binaries — and failing items over the caps — in
every stored workflow that carries them. `Auto` moves the decision into code, where it can read the
version.

To turn it on in a node you already have, set it to **On**. That works on any version, the same way
**Output Envelope** lets an older node opt into the 1.2 output shape.

### No breaking changes

- The six parameters are additive. A run with nothing attached makes no filesystem call, builds no
  content blocks, and sends the prompt as the plain string it always did.
- `diagnostics.attachments` is **absent** — not `null` — on a run with no attachments and no skips.
  All **48 golden fixtures** for typeVersions 1 and 1.1 are byte-identical and were not regenerated.
- An item carrying no binary data is unaffected however the parameters are set.
- One thing to know if you moved **Permission Mode** off its default: reading a *staged* file is a
  `Read` call, and under `default` or `dontAsk` an unapproved call is denied. Add `Read` to **Allowed
  Tools** if so. A tool *restriction* is handled for you — when files are staged and **Restrict
  Built-in Tools** is non-empty, `Read` is added to it, because staging a file the agent cannot read
  means the run answers without the evidence and still reports green.

### Fixes found while building this

- **A debug log that lied.** The staging applier mutated `options.tools` after the tool-restriction
  applier had already logged it, so a run that really sent `["Bash","Grep","Read"]` was logged as
  `["Bash","Grep"]` — misleading in precisely the situation that applier exists to make debuggable.
- **A broken docs link.** `ClaudeCodeUsage.node.json` pointed at `#-usage--plan-limits`, a leftover
  from when that heading carried an emoji. That is the URL n8n shows as **Docs** on the node.
- **Docs that contradicted the repo**, including the README calling `scripts/e2e/` untracked when it
  has been versioned since 0.12.0.

### Verification

662 unit tests, 0 failing. 48 golden fixtures byte-identical, unregenerated.

39 named checks against real n8n in Docker with the real SDK, 0 failing — including twelve that
exist only to prove a file reaches the *model*, which no unit test can show: an image whose colour
is named nowhere in the prompt, a value on the last row of a staged file, a PDF, an inline file and
a staged file in one request, and a staged file under a tool restriction that omits `Read`.

Two defects in this release were caught by that suite alone and by nothing else: the schema-default
problem above, and that n8n *strips* a parameter whose `displayOptions` condition is not met before
the node reads it — so naming Binary Properties while Attach All is on `Auto` resolved an empty list
and attached nothing. Naming properties now requires `Off`, which is the honest contract. The fake
`IExecuteFunctions` used by the unit tests resolves parameters from a plain map and does not model
`displayOptions` at all.

## [0.12.0](https://github.com/JVVeiga/n8n-nodes-claudecode/compare/v0.11.0...v0.12.0) (2026-08-22)

### No breaking changes

Verified rather than assumed: the resolved node schema was diffed field by field against the
previous release. All 13 parameter names, their types, defaults, `displayOptions` and option lists
are unchanged. Nothing was removed or renamed.

Two additive changes only:

- `version` gained `1.2`; `defaultVersion` moved from `1.1` to `1.2`. **A node keeps the
  typeVersion it was created with**, so this affects newly added nodes and nothing else. An existing
  workflow emits exactly what it emitted before — held byte-for-byte by 48 golden fixtures, and
  verified in real n8n with a 1.1-pinned node running alongside a 1.2 node in the same instance.
- **Fallback Model** gained two options (Opus 4.7 and Fable 5). No stored value becomes invalid.

There is nothing to migrate. If you *want* an existing node on the new output shape, set
**Output Envelope** to `Unified` in Additional Options — that opts in without recreating the node.
It defaults to `Auto`, which changes nothing.

That option exists because n8n has no UI picker for a node version and a node keeps the version it
was created with, so an older node otherwise has no route to the new shape except being deleted and
re-added, which loses its configuration. The override is deliberately one-directional: a *new* node
that wants the old shape is rare and can pin `"typeVersion": 1.1` in the workflow JSON.

#### Moving a workflow from 1.1 to 1.2

| | 1 / 1.1 | 1.2 |
|---|---|---|
| where the metrics live | flat on Text, nested on Structured, absent on Messages | always `metrics` |
| an unknown cost | `0` on Text | `null` |
| `messageCount` | on Messages only | dropped — read `messages.length` |
| error text | folded into `result` behind a `[PARTIAL - …]` prefix | `result`, plus a separate `errorText` |
| `summary.toolUseCount` | counts a tool only when it opened the turn | counts every tool use |
| metrics on a graceful timeout | the interrupt's per-turn numbers | the cumulative ones |

`result`, `success` and `diagnostics` keep their names and meanings in both, so an expression
reading only those needs no change.

### Features

* **node:** typeVersion 1.2 — one output envelope for all three formats. The three formats used to build three different shapes, deriving `result`, `success` and the metrics three separate ways, so adding a field meant remembering three places and the three could disagree about the same run. Under 1.2, `Output Format` chooses which optional *sections* are present, never which shape is built: `{ result, success, errorText, metrics{duration_ms, num_turns, total_cost_usd, usage, modelUsage, session_id}, diagnostics }`, plus `messages` for the messages and structured formats and `summary` for structured. Four long-standing quirks are fixed with it: an unknown cost reports `null` instead of `0` (a run with no result message may well have spent money, and `0` claimed it was free); the `messages` format finally carries metrics, so wanting the transcript no longer means running the node twice to learn what it cost; a tool use counts wherever it appears in a turn rather than only as the first content block, which had `summary.toolUseCount` under-reporting on exactly the runs people inspect; and the metrics come from the *last* result message rather than the first, which matters on a graceful timeout where the first is the interrupt's own per-turn count. `errorText` is also new and separate from `result`, so a recovered partial answer is distinguishable from a real failure without string-matching. **Existing nodes are unaffected** — a node keeps the typeVersion it was created with, and 1 and 1.1 emit exactly what they always did, held byte-for-byte by 48 golden fixtures and verified in real n8n alongside a 1.2 node in the same instance.

* **node:** **Output Envelope** in Additional Options — `Auto` (the default, routes by node version) or `Unified`, which gives an existing node the 1.2 output shape in place. n8n offers no way to change a node's version after it is created, so without this the only route to the new shape was deleting the node and configuring a new one from scratch.

* **models:** every model is now selectable as **Fallback Model**. The Model selector offered nine and Fallback Model offered seven of them — Opus 4.7 and Fable 5 could be the primary model but not the fallback. Nobody decided that; the two lists had drifted. They are generated from one list now, so they cannot drift again.

### Code Refactoring

* **node:** the node was one 1386-line file whose `execute()` was 876 lines with four escape paths, and nothing in it was reachable from a test. It is now fourteen modules, none over 358 lines, with `execute()` reduced to wiring: `params.ts` is the only place that touches `IExecuteFunctions`, `config.ts` turns parameters into SDK options through an ordered table of appliers (a new SDK option is one entry), `runner.ts` owns the query and the timeout choreography and reports a timeout rather than throwing one, and `output/legacy.ts` is frozen so 1.2 could be built beside it instead of on top of it. Test count went from 76 to 405, plus 48 golden fixtures and a 20-check Docker suite against real n8n, none of which existed before. No behaviour change on 1 or 1.1 — that is the point, and it is a test rather than a claim.

## [0.11.0](https://github.com/JVVeiga/n8n-nodes-claudecode/compare/v0.10.0...v0.11.0) (2026-08-19)

### Features

* **usage:** optional probe that reads the 5-hour and 7-day windows off inference response headers. A `claude setup-token` credential is inference-only, so the usage endpoint refuses it — but every inference response carries `anthropic-ratelimit-unified-5h/7d-utilization` and `-reset`, and the CLI reports those as utilisation when the endpoint is closed. **Probe With a Minimal Prompt If Unavailable** (off by default) sends one trivial Haiku turn to make those headers exist. Measured in a container whose only credential is `CLAUDE_CODE_OAUTH_TOKEN`: two windows returned, $0.001136 per read, reported in `session.totalCostUsd` and `diagnostics.probeCostUsd`. A batch pays once.

## [0.10.0](https://github.com/JVVeiga/n8n-nodes-claudecode/compare/v0.9.0...v0.10.0) (2026-08-19)

### Features

* **usage:** read plan limits on `CLAUDE_CODE_OAUTH_TOKEN` sessions. Such a session — the usual headless and Docker setup — reported no plan limits even on accounts that have them, because the CLI synthesises its scope record from `CLAUDE_CODE_OAUTH_SCOPES` and defaults to `user:inference` alone, while plan limits require `user:profile`. The node now retries the read with the scope declared, and `diagnostics.scopeRetried` marks the items that needed it. Off via **Declare Profile Scope for Token Sessions**. Note: a `claude setup-token` credential is inference-only by design, so the server refuses the lookup — the retry helps only when a stored login is also present, and the error text now names the two credentials that do work.

## [0.9.0](https://github.com/JVVeiga/n8n-nodes-claudecode/compare/v0.8.1...v0.9.0) (2026-08-19)

### Features

* **usage:** add a Claude Code Usage node that reads the logged-in account and how much of its Claude plan is left, including when each window resets. The read opens a session without sending a prompt, so it costs nothing: measured $0.00 and 1-3s per read on the Claude Agent SDK 0.3.202.
* **usage:** report `authenticated`, `planLimitsApply` and `rateLimitsAvailable` separately, because an unauthenticated CLI answers normally and the server can report limits as available while sending none.
* **usage:** one read per distinct Project Path per execution, with a shared `fetchedAt`, so a batch of items does not open a session each.

### Bug Fixes

* **templates:** the three shipped workflow templates declared the upstream `@johnlindquist` node type, so importing them with only this fork installed failed with "Unrecognized node type". They now declare `@joaoveiga` and node version 1.1.

### Notes

This file was dormant from 0.3.2 (the last semantic-release entry upstream) through 0.8.1, all of
which were manual releases. It resumes here; the missing entries are in the git log.

## [0.3.2](https://github.com/johnlindquist/n8n-nodes-claudecode/compare/v0.3.1...v0.3.2) (2025-08-01)

### Bug Fixes

* run prettier formatting and add format check to build process ([c54a923](https://github.com/johnlindquist/n8n-nodes-claudecode/commit/c54a9237565d2293d6b574046336e11558785548))

## [0.3.1](https://github.com/johnlindquist/n8n-nodes-claudecode/compare/v0.3.0...v0.3.1) (2025-08-01)

### ⚠ BREAKING CHANGES

* Debug logs now require N8N_LOG_LEVEL=debug to appear in console

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>

### Bug Fixes

* replace console.log with n8n logger and add JSON schemas ([7307e34](https://github.com/johnlindquist/n8n-nodes-claudecode/commit/7307e3415d99dc3cfc8781281497ab29b0958129))

## [0.3.0](https://github.com/johnlindquist/n8n-nodes-claudecode/compare/v0.2.2...v0.3.0) (2025-07-31)

### Features

* add advanced SDK options to Claude Code node ([e80d5f5](https://github.com/johnlindquist/n8n-nodes-claudecode/commit/e80d5f5866200cc94a5d3d9a851bf3b3ea8e5564))

## [0.2.2](https://github.com/johnlindquist/n8n-nodes-claudecode/compare/v0.2.1...v0.2.2) (2025-07-31)

### Bug Fixes

* add missing conventional-changelog-conventionalcommits dependency ([ff11b26](https://github.com/johnlindquist/n8n-nodes-claudecode/commit/ff11b2629d1576168a1d27c8cc31915a90ba8eda))
