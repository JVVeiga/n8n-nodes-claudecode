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
