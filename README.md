# Claude Code for n8n

Run the Claude Code agent as a step in an n8n workflow: give it a prompt and a project directory,
and it reads, writes and runs things the way it does in a terminal — then hands the result to the
next node.

The package installs two nodes. **Claude Code** runs the agent. **Claude Code Usage** reads how much
of the account's plan is left and when each window resets, so a workflow can check capacity before
it starts spending.

[![n8n](https://img.shields.io/badge/n8n-community_node-orange.svg)](https://n8n.io/)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Powered-blue.svg)](https://claude.ai/code)
[![npm](https://img.shields.io/npm/v/@joaoveiga/n8n-nodes-claudecode.svg)](https://www.npmjs.com/package/@joaoveiga/n8n-nodes-claudecode)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE.md)

Built on the Claude Agent SDK, for Claude Code v2. Requires Node 22+. Originally derived from the
work of Adam Holt and John Lindquist — see [Credits](#credits).

## What it gives you

**Control over what a run costs and how long it takes.** Effort from low to max, plus Ultracode
(xHigh with dynamic workflow orchestration). A **Max Budget (USD)** hard cap, because Max Turns and
Timeout bound how *long* a run goes, not what it *costs*. Model and fallback model, thinking depth,
and a thinking display mode.

**Timeouts that still report what happened.** A run that overruns is interrupted rather than killed,
so it reports the tokens, cost and session it actually used and hands over what it finished.
Killing the process makes the SDK report none of that. See [Timeouts](#timeouts).

**A real bound on the tool set.** **Restrict Built-in Tools** is the allowlist that actually limits
what the agent can reach. The SDK's own *Allowed Tools* is an auto-approve list — it pre-approves
tools rather than restricting them, which is a distinction worth knowing before you rely on it.
**Disallowed Tools** removes tools from the model's context entirely.

**Evidence of what ran.** Every run reports the model the CLI resolved to, the effort it actually
applied after its own downgrades, which models were billed, the session id, and whether Ultracode
orchestration was available. A failed run reports its real cost instead of `$0`.

**Failures that behave like failures.** Stopping the n8n execution stops the agent, instead of
leaving it running and spending with its output discarded. A failed run reaches the error output
branch instead of hiding behind a green execution.

**Plan capacity you can branch on.** The Usage node reads the same data behind the CLI's `/usage`
and sends no prompt, so nothing is billed. Gate a batch on remaining capacity, wait for a reset, or
alert before hitting the wall. A `CLAUDE_CODE_OAUTH_TOKEN` session — the usual Docker setup — cannot
read that endpoint at all, so there is an opt-in fallback that reads the two main windows off
inference response headers for about $0.001. See [Usage & Plan Limits](#usage--plan-limits).

**Files, not descriptions of files.** Attach the binary data already on the n8n item — a Monday
screenshot, a CSV export, an HTML capture, a PDF — and the model receives the file itself. Images go
in as images, so vision works without any tool being enabled; a file too large or of a type no
content block can carry is written to a temporary directory the agent can read from instead. See
[Attachments](#attachments).

**Sessions you can resume.** A **Session ID** on Continue, so concurrent executions stop sharing
one conversation.

**One output envelope.** The three output formats share a shape; the format picks which optional
sections you get. See [Output Formats](#output-formats).

## Contents

**Start here** — [Install](#install) · [Your First Workflow](#your-first-workflow) · [Templates](./workflow-templates/) · [What people build with it](#what-people-build-with-it)

**Reference** — [Authentication](#authentication) · [Features](#features) · [Attachments](#attachments) · [Timeouts](#timeouts) · [Output Formats](#output-formats) · [Claude Code Chat Model](#claude-code-chat-model) · [Agent Tools](#claude-code-tools-for-ai-agents) · [Usage & Plan Limits](#usage--plan-limits) · [Node versions](#node-versions) · [Configuration Examples](#configuration-examples)

**Also** — [Notes worth knowing](#notes-worth-knowing) · [Development & Contributing](#development--contributing) · [Credits](#credits)

## What people build with it

Four templates ship in [`workflow-templates/`](./workflow-templates/), ready to import:

| Template | Shape |
|---|---|
| [Automatic Bug Fixer](./workflow-templates/automatic-bug-fixer.json) | GitHub issue webhook → agent diagnoses and writes a fix → opens a PR |
| [Documentation Generator](./workflow-templates/codebase-documentation-generator.json) | Schedule → agent reads the codebase → writes docs → commits |
| [Customer Support Automation](./workflow-templates/customer-support-automation.json) | Support ticket → agent reproduces the issue → drafts a fix and a reply |
| [Plan Limit Guard](./workflow-templates/plan-limit-guard.json) | Usage node checks remaining capacity → branches before the agent spends anything |

Other things that fit the shape well: turning a Slack command into a pull request, triaging error
logs into issues with a diagnosis attached, generating a migration script from a described schema
change, or reviewing a diff against standards that live in the repo's own `CLAUDE.md`.

**One caution, since the templates make it look easy.** These workflows let an agent write files and
run commands. Keep a human review step before anything merges or deploys, keep **Max Budget (USD)**
set, and use **Restrict Built-in Tools** to bound what a given workflow can reach. An agent that can
open a PR is useful; one wired straight to production is a liability.

## Install

### Prerequisites
1. **Claude Code CLI** (required on your n8n server):
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude  # Authenticate (requires Claude Pro/Team subscription)
   ```

### Install in n8n

#### Option 1: Via n8n UI (Recommended)
1. Open your n8n instance
2. Go to **Settings** → **Community Nodes**
3. Click **Install a community node**
4. Enter: `@joaoveiga/n8n-nodes-claudecode`
5. Click **Install**
6. Restart n8n when prompted

#### Option 2: Manual Installation
```bash
cd ~/.n8n/nodes
npm install @joaoveiga/n8n-nodes-claudecode
# Restart n8n
```

#### Option 3: Docker
```bash
docker run -it --rm \
  -p 5678:5678 \
  -e N8N_COMMUNITY_NODE_PACKAGES=@joaoveiga/n8n-nodes-claudecode \
  -v ~/.n8n:/home/node/.n8n \
  n8nio/n8n
```

**Note**: For Docker, you'll need to ensure Claude Code CLI is installed inside the container. Consider creating a custom Dockerfile.

📦 **NPM Package**: [@joaoveiga/n8n-nodes-claudecode](https://www.npmjs.com/package/@joaoveiga/n8n-nodes-claudecode)

## Authentication

By default both nodes run as whoever the **n8n host** is logged in as — the account behind
`claude login` on that machine, or an `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` exported into
the container. That is one identity for the whole instance: one bill, one set of plan limits, and no
way to run two workflows on two accounts.

The **Authentication** parameter, on both nodes, changes that per execution.

| Mode | What it does | Credential |
|---|---|---|
| **Host** (default) | Runs as the account the n8n container itself is logged in as. Exactly what every run did before this parameter existed. | none |
| **API Key** | Runs this execution on an Anthropic API key, billed as API usage. | *Claude Code API* |
| **OAuth Token** | Runs this execution on a Claude Code OAuth token (`claude setup-token`), billed against that account's Claude plan. | *Claude Code OAuth Token API* |

Three workflows can therefore run side by side on three different accounts, each with its own
credential, rotated in n8n rather than in the container.

### How it works, and why it actually overrides the host

The node hands the credential to the Claude Code CLI subprocess through its environment —
`ANTHROPIC_API_KEY` for a key, `CLAUDE_CODE_OAUTH_TOKEN` for a token — and the CLI only falls back
to the host's `~/.claude/.credentials.json` when neither of those is set. So the credential wins,
and the host login is never read, written or refreshed for that execution.

Every other authentication variable the SDK recognises is **removed** from that environment first,
including `ANTHROPIC_AUTH_TOKEN` and the Bedrock, Vertex and Foundry keys. A container that exports
`ANTHROPIC_API_KEY` globally cannot leak it into a run you pointed at an OAuth token. Everything
that is not authentication — `PATH`, `HOME`, proxy variables — is passed through untouched.

A run that used a credential says so, in `diagnostics.auth` (`"apiKey"` or `"oauthToken"`). A
host-mode run has no such field at all, which is why adding this feature moved no existing
workflow's output and needed no new node version.

### What is *not* per-credential

The credential changes **who pays and who is rate-limited**. It does not partition anything else:

- `~/.claude` is still the host's, so `settings.json`, MCP servers and plugins apply to every run
  whichever credential it uses. That is deliberate — a workflow's tools should not change with its
  billing.
- The **session store is shared**. `Continue` with no Session ID still resolves "the most recent
  conversation in this working directory" across every execution on the instance, regardless of
  credential. Set an explicit Session ID for concurrent runs, as before.

### Notes

- A credential that is selected but empty **fails the item**. It does not fall back to the host —
  running on an account you explicitly pointed away from is worse than stopping.
- The **Claude Code API** credential has a Test button. The **Claude Code OAuth Token** credential
  does not: those tokens have no documented HTTP endpoint to test against, and a test built on a
  guess would put a red cross on a working credential. The first run is the test.
- An API key authenticates against the API, not a Claude plan, so the Usage node reports no plan
  limits for it — see [Usage & Plan Limits](#usage--plan-limits).
- **A rejected credential takes minutes to say so.** The CLI retries a 401 with backoff rather than
  giving up. Measured: with the default 300s Timeout the run fails after ~184s with
  `Failed to authenticate. API Error: 401 API key is invalid.` — clear, but slow. With a Timeout
  shorter than the retry window (20s, measured) your own timeout fires first and the run reports
  *0 assistant turns* and an unknown cost, saying nothing about authentication at all. So: a
  credentialed run that times out with no turns is a credential to check, and **Debug** shows the
  `authentication_failed` responses in the n8n log either way.

## Features

### Project path

Point the node at a directory and the agent works there: it reads the existing code, picks up the
conventions already in it, and loads whatever `CLAUDE.md`, `.claude/settings.json` and `.mcp.json`
that directory carries. This is the difference between an agent that guesses and one that follows
the project it is editing.

In Docker, the directory has to be mounted into the container — a path that exists only on the host
fails with a `spawn ENOENT` the SDK misattributes to an architecture mismatch, so the node checks it
up front and says so plainly instead.

### Tools

The agent gets the Claude Code tool set: reading, writing and editing files, running shell commands,
searching a codebase, fetching web pages, managing todos, and launching subagents. Three selectors
shape what a given workflow can use:

| Selector | What it actually does |
|---|---|
| **Restrict Built-in Tools** | the real allowlist — an empty selection means the full set |
| **Allowed Tools** | the SDK's auto-approve list; pre-approves, does not restrict |
| **Disallowed Tools** | removes tools from the model's context entirely |

### Permission modes

`bypassPermissions` is the default, because n8n runs headless and cannot answer a prompt — anything
else would silently deny every tool that is not pre-approved. `plan` produces a plan and writes
nothing; pair it with **Allow Plan Execution** if you want the agent to be able to leave plan mode
and act, since without a permission callback registered plan mode has no exit.

### MCP servers

The node does not configure MCP itself. It loads whatever the target directory already declares in
`.mcp.json` and `.claude/settings.json`, which means a workspace set up for interactive Claude Code
works unchanged here — database access, GitHub, Slack, or anything custom. See
[`examples/project-with-mcp/`](./examples/project-with-mcp/).

## Attachments

Binary data on the incoming item can go to Claude with the prompt. The typical case is fixing a bug
from evidence: a Monday item arrives carrying a screenshot of the broken screen, a CSV export of the
failing rows and an HTML capture of the response, and all three reach the model in the same request.

Two parameters select what goes:

| Parameter | |
|---|---|
| **Attach All Binaries** | send every binary property on the item, ordered by property name — `Auto` / `On` / `Off`, defaulting to `Auto` |
| **Binary Properties** | a comma-separated list, when you want only some of them — **available only when Attach All Binaries is `Off`** |

Both sit under **Project Path**, since they describe what goes into the request rather than how it
runs.

**Attach All Binaries defaults to `Auto`, which is on for a node you add now** — an item that
carries a file usually carries it for a reason, and the property names often come from upstream and
vary, since Monday emits `data_0`, `data_1`, `data_2` with no fixed count. An item with no binary
data is unaffected: nothing is collected and nothing is sent. Set it to `Off` and name properties
instead when you want to leave a heavy attachment out and not pay tokens for it, or `Off` with an
empty list for a text-only request.

**Upgrading changes nothing in a workflow you already built.** `Auto` means on from node version
1.3 and off below it, and a node keeps the version it was created with — so an existing node stays
off until you say otherwise. To turn it on there without recreating it, set it to `On`, which
overrides the version either way.

### Attached directly, or staged on disk

Each file takes one of two routes, decided by its type and its size.

**Attached directly** — the file is part of the request. The model has it immediately, no tool is
involved, and it works even with **Restrict Built-in Tools** set to something that excludes `Read`.

| Type | Ceiling |
|---|---|
| `image/png`, `image/jpeg`, `image/gif`, `image/webp` | 5 MB — an API limit |
| `application/pdf` | 20 MB — an API limit |
| `text/*`, plus JSON, XML, YAML, SVG, SQL, JS/TS | **Inline Text Size Limit (KB)**, default 256 |

**Staged on disk** — everything else: a file over one of those ceilings, or a type with no matching
block (`.xlsx`, `.zip`, `.heic`, `.docx`). It is written to a temporary directory, that directory is
made readable to the agent, and the prompt tells it which files are there. The agent reads what it
needs with `Read`, and can `grep` a 40 MB log rather than swallowing it.

The temporary directory is removed when the item finishes — on success, on error, and on a timeout.

### Narrowing by file type

**Allowed Extensions** in Additional Options is a multi-select of ~120 extensions. Leave it empty —
the default — and every file is considered. Select some and only those are sent; anything else on
the item is **skipped and the run continues**.

That is deliberately different from the failures below. A size cap or a property that is not on the
item is a refusal of something you asked for, so it stops the item. The extension filter is you
saying which types you want, so not sending the rest is doing what you asked — it never fails
anything.

It pairs with **Attach All Binaries** being on: attach everything, then narrow to the types that
matter.

```
Attach All Binaries   [x]
Allowed Extensions    PNG, CSV, PDF

item carries  shot.png, export.csv, archive.zip
              →  shot.png and export.csv sent
              →  archive.zip skipped, reported, run continues
```

Two details worth knowing. The filter runs on the **derived** filename, so a binary that arrives
with no filename at all is still judged on the extension its MIME type implies. And it runs before
the count and size checks, so a file you told it to ignore can never be what trips **Max Attachment
Count**.

Everything skipped is listed under `diagnostics.attachments.skipped` with the property name, the
derived filename and the extension — because "ignore and continue" is exactly the pattern that goes
wrong quietly, and you should be able to see it did.

### Choosing the text limit

This is the one size knob that is a real trade rather than an API limit. An attached file sits in the
context on **every turn**, so 256 KB of CSV is roughly 64k tokens per turn. A staged file costs
nothing until the agent reads it — but the agent has to decide to read it, and might not.

Attach when the file is the point of the request. Stage when it is reference material the agent
should search. Set the limit to `0` to stage every text file.

### Two things that will bite you

**A permission mode other than `bypassPermissions` can make a staged file unreachable.** Reading from
the staged directory is a `Read` call, and under `default` or `dontAsk` a call that is not
pre-approved is denied — n8n runs headless and cannot answer a prompt. The node's default is
`bypassPermissions`, so this only applies if you changed it; if you did, add `Read` to **Allowed
Tools**. A tool *restriction* is handled for you: when files are staged and **Restrict Built-in
Tools** is non-empty, `Read` is added to it, because staging a file the agent cannot read means the
run answers without the evidence and still reports green.

**A file that cannot be sent fails the item.** A binary property that is not on the item, a file over
**Max Attachment Size (MB)**, or more attachments than **Max Attachment Count** each stop that item
with a message naming the property. This is deliberate: the alternative is an answer about a file the
model never saw. `Continue On Fail` still applies, and routes the item to the error output.

### What the run reports

When at least one attachment was sent **or skipped**, `diagnostics.attachments` says what happened:

```json
{
  "count": 2,
  "totalBytes": 42123456,
  "skipped": [
    { "propName": "data_3", "fileName": "archive.zip", "extension": "zip" }
  ],
  "inline": [
    { "name": "shot.png", "mimeType": "image/png", "bytes": 245760, "as": "image" }
  ],
  "staged": {
    "dir": "/tmp/n8n-claude-9f3c1a7b2e5d4088",
    "files": [{ "name": "dump.csv", "mimeType": "text/csv", "bytes": 41877696 }]
  }
}
```

`count` is what was **sent** — a skipped file is reported separately rather than folded in, because
"3 attachments" meaning "2 sent and 1 dropped" is how a wrong answer gets missed. `skipped` is always
present so an expression can read `.skipped.length` without guarding, and `staged` is `null` when
everything was attached directly. The whole key is absent on a run with no attachments and no skips,
which is why this feature needed no new node version.

## Timeouts

A long agentic run that hits its **Timeout** used to report nothing but a string:

```
Operation timed out after 900 seconds. Consider increasing the timeout in Additional Options.
```

Fifteen minutes of real spend, and no record of how much it cost, how far it got, or which session
to resume. That is because killing the Claude Code process outright makes the SDK emit no accounting
at all.

**Timeout Wrap-Up Grace (Seconds)** fixes this. Instead of killing the process at the deadline, the
node *interrupts* it a little earlier and asks Claude to stop and hand over what it did. Interrupting
is what makes the SDK report the run, so a timed-out node now returns real numbers and a usable
answer.

```
Claude Code timed out after 900s (wrap-up summary returned) — 47 turns, $4.81 spent, session c0ffee…
```

### How the grace window works

The grace is taken **out of** the Timeout, never added to it. A node set to `timeout: 900` with
`Timeout Wrap-Up Grace: 60`:

| At | What happens |
|---|---|
| 840s | Claude is interrupted. The SDK emits the run's cumulative cost, tokens and session ID within ~100ms. |
| 840s–900s | Claude writes a handover: what it finished, what is unfinished, how to resume. |
| 900s | Hard abort, unconditionally — a wrap-up that hangs cannot push the run past your Timeout. |

Set it to `0` to kill the process at the Timeout instead. You then get the session ID, the tool
timeline and the last thing Claude said, but **no tokens and no cost** — the SDK never reports them
for a killed process, and this node will not invent them.

The grace is clamped to half the Timeout, so a large grace on a short Timeout cannot swallow the run.

> **On timing:** the interrupt and the abort both fire exactly on schedule, but after an abort the
> SDK spends about two seconds killing the subprocess. So a hard-aborted node returns up to ~3s after
> its Timeout, while the graceful path returns *under* it. Claude stops working on time either way.

### Node versions

Anything that changes what a node *emits* is gated behind its version, never switched on by a
package upgrade. **A node keeps the version it was created with**, so upgrading the package never
changes an existing workflow. New nodes start on the current default, `1.2`.

| | 1 | 1.1 | 1.2 (default) |
|---|---|---|---|
| Timeout Wrap-Up Grace default | `0` — killed at the Timeout | `60` | `60` |
| Failure item shape | flat report at the top level | `{ error, message, details }` | same as 1.1 |
| Failure items on the error output | stay on the main output | routed to the error output | same as 1.1 |
| Output shape | one per format | one per format | [one envelope](#output-formats) |

All three get the diagnostics, the session ID and the self-describing error message. Nothing else is
version-gated: [Attachments](#attachments) work identically on all three, because they change what
goes *in* rather than what comes out.

To give an existing node the newer output shape without recreating it, set **Output Envelope** to
`Unified` in Additional Options. It defaults to `Auto`, which routes by version and changes nothing.

That option exists because n8n has no version picker: a node keeps the version it was created with,
and there is no UI to move it. Without the override, adopting the new shape meant deleting the node
and configuring a replacement from scratch. The override only works in that direction — a new node
that wants the old shape is rare, and can pin `"typeVersion": 1.1` in the workflow JSON.

### Reading the timeout data in the next node

Set the node's **On Error** to *Continue (using error output)* — or *Continue (using regular
output)* — and the timeout item carries the whole report under `details`:

```javascript
{{ $json.error }}                      // one-line summary: timed out, turns, cost, session
{{ $json.message }}                    // token breakdown and how to resume
{{ $json.details.total_cost_usd }}     // 4.812 — cumulative across the whole run
{{ $json.details.num_turns }}          // 47
{{ $json.details.usage.outputTokens }}
{{ $json.details.session_id }}         // feed to the Continue operation to resume
{{ $json.details.result }}             // the handover summary
{{ $json.details.timedOut }}           // true
```

> **Why `details` and not the top level?** n8n sends an item to the error branch when the item has a
> top-level `error` field, *or* when its json holds nothing beyond `error`, `message` and `details`.
> The top-level field looks like the natural choice, but n8n then rewrites the item's json to just
> `{ error: <message> }` and every metric is lost. Using the three permitted keys keeps the routing
> and the report. On node version 1 the report stays flat at the top level, and never reaches the
> error branch at all.

Everything inside `details`:

| Field | Meaning |
|---|---|
| `error` | Self-describing message string, same convention as every other n8n node |
| `errorType` / `timedOut` | `'timeout'` / `true` — a timeout is never mistakable for a generic failure |
| `terminationReason` | `'timeout_graceful'` or `'timeout_hard_abort'` |
| `timeoutSeconds`, `wrapUpGraceSeconds`, `wrapUpSucceeded` | What was configured, and whether the handover made it |
| `result`, `resultSource` | The handover text, and whether it came from the wrap-up or from the last thing Claude said |
| `total_cost_usd`, `num_turns`, `usage`, `modelUsage` | Cumulative spend. `null` when the process was killed |
| `usageReliable` | `false` when the numbers are unavailable, so you can branch on it |
| `session_id` | Resume the run with the Continue operation |
| `toolTimeline`, `toolUseCount`, `toolTimelineTruncated` | The last 100 tool calls, and the true total |
| `duration_ms`, `assistantTurns`, `messageCount`, `diagnostics` | Everything else about the run |

With **On Error** left at its default the execution still fails, as it should. What you see in the
error panel is the message and the description:

```
Problem in node ‘Claude Code‘
Claude Code timed out after 25s (wrap-up summary returned) — 6 turns, $0.0651 spent, session dd05ec45…
Grace window: 10s. Tokens: 650 in / 1080 out / 100893 cache read / 3022 cache write.
Models: claude-haiku-4-5, claude-sonnet-5. Tools used: 3.
Resume with the Continue operation and session id dd05ec45….
```

The full report is also attached to the error object and saved with the execution, but n8n 2.34.6
does not render it in the panel — *Other info* there shows only the node type, versions, time and
stack trace. That is why the message and description are written to stand on their own. Use one of
the continue modes above when a following node needs the numbers.

An **Error Workflow** gets more than the panel does. The `Error Trigger` receives the whole report:

```javascript
{{ $json.execution.error.message }}                    // the one-line summary
{{ $json.execution.error.context.total_cost_usd }}     // 0.0257
{{ $json.execution.error.context.session_id }}
{{ $json.execution.error.context.usageReliable }}
{{ $json.execution.lastNodeExecuted }}                 // "Claude Code"
```

So an alerting workflow can report what a timed-out run cost without any extra wiring. The message
still carries the headline numbers inline, because that is the line a human reads in a Slack alert.

## Output Formats
The Claude Code node offers three (the Usage node has one fixed shape — see
[Usage & Plan Limits](#usage--plan-limits)):
- **Structured**: everything — the answer, the metrics, a run summary, the transcript
- **Messages**: the transcript, for debugging
- **Text**: just the answer and the metrics, for chaining

Since **node version 1.2** all three share one envelope, and Output Format selects which optional
sections come with it:

```javascript
{
  result: 'pong',              // the answer, whatever it took to recover it
  success: true,               // only an explicit success counts
  errorText: '',               // separate from result, so a partial answer is distinguishable
  metrics: {
    duration_ms: 4821,
    num_turns: 2,
    total_cost_usd: 0.0412,    // null when the run produced no result — never a fabricated 0
    usage: { /* … */ },
    modelUsage: { /* per model */ },
    session_id: '1e76098f-…',  // feed into Session ID to resume
  },
  diagnostics: { /* resolved model, applied effort, whether Ultracode fired */ },
  messages: [ /* messages + structured only, and only with Include Raw Transcript on */ ],
  summary: { /* structured only */ },
}
```

**Existing workflows are untouched.** A node keeps the typeVersion it was created with, so nodes
built before 1.2 keep emitting exactly what they always did — a flat `duration_ms` and
`total_cost_usd` on Text, `messageCount` on Messages, a nested `metrics` on Structured. Only a
newly added node starts on 1.2. To move an old one, delete and re-add it.

What 1.2 changes, for anyone porting a workflow across:

| | 1 / 1.1 | 1.2 |
|---|---|---|
| where the metrics live | flat on Text, nested on Structured, absent on Messages | always `metrics` |
| an unknown cost | `0` on Text | `null` |
| `messageCount` | on Messages only | dropped — use `messages.length` |
| error text | folded into `result` with a `[PARTIAL - …]` prefix | `result` plus a separate `errorText` |
| `summary.toolUseCount` | counts a tool only if it opened the turn | counts every tool use |
| metrics on a graceful timeout | the interrupt's per-turn numbers | the cumulative ones |

## Claude Code Chat Model

The third node plugs Claude Code into n8n's **AI Agent** as its Chat Model. Add an AI Agent,
click the Chat Model port, pick **Claude Code Chat Model** — Memory and Tool sub-nodes connect as
usual, and the Chat Trigger streams the answer token by token.

What you get over the native Anthropic Chat Model:

- **Your Claude plan, not an API key.** The same per-execution [Authentication](#authentication)
  as the other two nodes — Host, API Key, or a Claude Code OAuth Token billed against that
  account's plan.
- **A project behind the model.** Set **Project Path** and the run loads that directory's
  `CLAUDE.md`, MCP servers and settings; Claude Code's own tools (Bash, Read, Glob, …) are
  available alongside the Agent's, governed by the same Restrict / Allowed / Disallowed Tools,
  Effort, Thinking, Max Budget and Timeout options as the main node.

**How the Agent's tools run.** Tools you connect to the Agent are handed to Claude Code as
in-process tools (`mcp__n8n__<tool name>`) and executed *inside its session*, so the Agent sees
one model turn per call while each Tool sub-node still logs its executions. Two Agent features
therefore do not apply — human-in-the-loop tool approval and *Return Intermediate Steps*.
**Require Specific Output Format works**: the model hands back the formatting call the Agent's
parser expects.

**Two ways to remember, and you pick which.** The **Conversation Memory** parameter chooses:

| Mode | Where the history comes from |
|---|---|
| **Auto** (default) | Session when Session ID is filled in, Memory sub-node otherwise |
| **Claude Code Session** | The session — real multi-turn, tool results included. Requires a Session ID; an empty one fails the node instead of running stateless. Any connected Memory is ignored |
| **n8n Memory Sub-Node** | The connected Memory, flattened into the prompt. Portable across containers and workers; the model *reads* the conversation rather than continuing it. Session ID is hidden — and **cleared when the workflow saves**, so note your key before switching |

Never both at once — that would put every prior turn in the context twice.

With a Memory sub-node, each Agent call is a fresh Claude Code session that reads the
conversation so far. For real multi-turn memory, set **Session ID** to any **stable conversation
key** — a Discord/WhatsApp/user ID, straight off the webhook (`{{ $json.body.sessionId }}`). The
node hashes the key into a deterministic Claude Code session ID, creates the session on the
conversation's first message and *resumes* it on every next one — prior turns and tool results
included, with **no storage anywhere**: not in the workflow, not in the caller. A raw session
UUID from a previous run also works. When Session ID is set, connected Memory history is not
re-sent, so the Memory node becomes unnecessary. Sessions live on the n8n container's disk —
recreate the container and conversations start over. `response_metadata.session_state` says what
happened on each call: `created`, `resumed`, or `new`.

**What it costs.** Every Agent call spawns the Claude Code CLI (a few seconds) and carries Claude
Code's system prompt. This is not a cheap chat model — it is Claude Code with an Agent plugged
into it. For a plain LLM call on an API key, the native Anthropic Chat Model is the better tool.

## Claude Code Tools for AI Agents

Two purpose-built `ai_tool` sub-nodes, for **any** Agent chat model — the native Anthropic or
OpenAI models included:

**Claude Code Task Tool** — hands the Agent a full coding agent as a tool. Fixed contract: the
Agent sends one `task` string, Claude Code runs it in the configured Project Path (reading files,
running commands, writing code), and the result comes back as text. Timeout, budget cap, tool
restrictions and per-execution Authentication are all per-tool options. Failures — timeouts
included — return as text the Agent can read and react to, never as a dead run.

**Claude Code Usage Tool** — a zero-argument tool that returns the account's plan usage
(utilisation and reset time per window) as a JSON report, with the same scope-retry and opt-in
probe escalation as the Usage node.

Both derive their tool name from the node's name on the canvas, so rename the node and the Agent
sees the new name. **Avoid names that collide with Claude Code's own tools** — a node called
"Task" makes the model reach for its built-in `Task` subagent instead of yours.

Both also log every call under the node, with the input and the result, so a tool that ran is
visible on the canvas rather than silent.

> **Alpine note**: the official `n8nio/n8n` image ships no `bash`, so Claude Code's Bash tool
> fails there with "No suitable shell found". Disallow **Bash** on the tool and let it use Glob
> and Read, or run n8n on an image that has a shell.

### Measuring what a sub-node spent

The main Claude Code node puts `metrics` and `diagnostics` in its output, so a following node
reads them with an expression. **A sub-node cannot do that** — its output is not on the `main`
chain, and `$('Claude Code Chat Model').item.json.metrics` has nothing to resolve against.

So the numbers leave by calling a workflow. On the Chat Model and the Task Tool, under Options:

| Option | What it does |
|---|---|
| **Report Usage to Workflow** | after every call, hands the run to this workflow |
| **Process Name** | sent as `process_name`, so rows from different workflows stay apart |

Each call sends one item:

```json
{
  "process_name": "support-assistant",
  "run_key": "1274:Claude Code Chat Model:1",
  "caller_workflow_id": "wF1aBcD2eFgH3iJk",
  "caller_execution_id": "1274",
  "node_name": "Claude Code Chat Model",
  "metrics":     { "duration_ms": 7329, "num_turns": 2, "total_cost_usd": 0.0070098,
                   "usage": { … }, "modelUsage": { … }, "session_id": "b575370d-…" },
  "diagnostics": { "requestedModel": "…", "resolvedModel": "…", "appliedEffort": "…", … }
}
```

`metrics` and `diagnostics` are **the same objects the main node emits** — a test asserts the
metrics are deep-equal to what the main node's output builder produces — so a collector written
for the main node consumes a sub-node's run with no changes.

**`run_key` identifies a call, not a session.** A conversation that resumes a Claude Code session
carries the same `session_id` across executions, so keying a table on it would make every message
overwrite the last, and `total_cost_usd` is per run rather than cumulative. The session id is an
ordinary field instead, which is what makes "what did this conversation cost" a `GROUP BY`.

Three things that will bite you, all measured:

- **The collector must be published.** n8n 2.x has a draft/publish model, and `executeWorkflow`
  resolves the *published* version — an unpublished one is refused with *"Workflow is not active
  and cannot be executed"*. Marking it active is not enough.
- **Its trigger must accept the payload.** An Execute Workflow Trigger that declares fields
  rejects anything else with *"At least 1 field is required"*; declare the fields you want or set
  the trigger to *passthrough*.
- **Reporting never costs you the answer.** The call is made with `doNotWaitToFinish` and any
  failure is swallowed into the debug log — a collector that is down loses a metric, not a run.

The **Usage Tool** has no reporting, deliberately: it performs a plan *read*, so there is no
session, no turns and no tokens. A row from it would be a line of zeros in a table of runs.

> **Why not the auto-generated variants?** n8n also synthesizes "tool" wrappers from the regular
> nodes (`usableAsTool`). Those expose every node parameter and — for the main node — a
> zero-argument schema unless you hand-write `$fromAI()` expressions. They keep working, but the
> dedicated tools above are the supported path.

## Usage & Plan Limits

The package ships a second node, **Claude Code Usage**, for the question the query node cannot
answer: how much of the plan is left, and when it comes back. It is the data behind the CLI's
`/usage`, as workflow items.

It costs **nothing** by default: the node opens a session, asks two control requests, and closes. No
prompt is sent, no tool runs, no turn is billed — measured on the Claude Agent SDK 0.3.202 at `1–3s`
per read, `$0.00`, no assistant message. One fallback, off by default, does pay for a single turn; it
is the last of the notes below and it exists because some credentials cannot read the usage endpoint
at all.

Search the nodes panel for `usage`, `limits`, `cota` or `consumo` to find it.

```
Schedule Trigger → Claude Code Usage → IF maxUtilization > 85 → Slack alert
                                                             → else → Claude Code
```

### Parameters

| Parameter | Default | What it does |
|---|---|---|
| **Project Path** | current dir | Directory the read runs in. Auth is account-wide, but settings, env and **hooks** resolve per directory — a path with slow `SessionStart` hooks makes the read slower. |
| **Timeout** | `60` | Seconds for the whole read: CLI startup, hooks, both control requests, and the probe turn when one runs. |
| **Error If Limits Unavailable** | `false` | Fail the item when no plan windows come back. Turn on when the workflow gates on capacity and running blind is worse than failing. |
| **Declare Profile Scope for Token Sessions** | `true` | Retry the read declaring `CLAUDE_CODE_OAUTH_SCOPES` when auth comes from `CLAUDE_CODE_OAUTH_TOKEN`. Without it such a session reports no plan limits even on a Max or Team account — see below. |
| **Probe With a Minimal Prompt If Unavailable** | `false` | Last resort when no windows come back: send one trivial Haiku turn so its response headers carry the utilisation. **Costs about $0.001 per read** — the only paid path in this node. |
| **Include Account Email** | `false` | Adds `account.email`. Off by default — the organisation and plan already identify the account, and n8n saves node output with every execution. |
| **Include Raw Limits** | `false` | Adds `limitsRaw`, the server's own `limits[]` with `kind`, `group`, `severity`, `scope` and `is_active`. |
| **Path to Claude Code Executable** | bundled | Same as on the query node. |
| **Debug Mode** | `false` | Logs the request timings, the window count, undeclared bucket names, whether the read was reused from the batch, and whether the scope retry or the probe ran. |

One item in, one item out. With several input items the node reads **once per distinct Project
Path** and gives every item served by that read the same `fetchedAt` — plan capacity is
account-wide, so a 3-item batch has no reason to open three sessions.

### Output

```javascript
{{ $json.maxUtilization }}          // 72 — the fullest window, 0-100
{{ $json.maxUtilizationKey }}       // 'five_hour'
{{ $json.nextResetInSeconds }}      // 3477 — feed straight into a Wait node
{{ $json.nextResetAt }}             // '2026-08-19T06:10:00.394384+00:00'
{{ $json.rateLimitsAvailable }}     // true — there are numbers to read
{{ $json.windows[0].utilization }}  // windows are sorted fullest-first
{{ $json.account.organization }}    // 'Gaudium'
```

| Field | Meaning |
|---|---|
| `fetchedAt` | When the read happened. Every countdown in the item derives from it |
| `account` | `organization`, `subscriptionType`, `apiProvider`, `tokenSource`, `apiKeySource`, plus `email` when enabled |
| `authenticated` | `false` when the CLI has no login at all. An unauthenticated CLI **does not fail** — it answers with `tokenSource: "none"` and no plan data, which otherwise looks exactly like a healthy API-key session |
| `subscriptionType` | `'pro'`, `'max'`, `'team'`, `'enterprise'`, or `null` |
| `rateLimitsAvailable` | **True only when at least one window came back.** Branch on this |
| `planLimitsApply` | Whether plan limits apply to this login at all — `false` for API key, Bedrock, Vertex |
| `windows[]` | One entry per window: `key`, `utilization`, `resetsAt`, `resetsInSeconds`, `limitDollars`, `usedDollars`, `remainingDollars`. Sorted by utilization descending |
| `maxUtilization`, `maxUtilizationKey` | The binding constraint, so an IF node needs no array walking |
| `nextResetAt`, `nextResetInSeconds` | The soonest reset **among windows actually consuming quota** |
| `extraUsage` | Extra-usage credits: `isEnabled`, `monthlyLimit`, `usedCredits`, `utilization`, `currency`, plus `disabledReason` and `spendLimitReached` — the actionable half of `isEnabled: false` |
| `claudeCodeVersion` | The CLI version, from the session's init message. Only present on a probe read — a session with no turn never emits one |
| `session` | The node's **own** session, opened to ask the question. Zero unless the probe ran, in which case it is what the probe cost |
| `limitsRaw` | Only when Include Raw Limits is on |
| `unsupported` | `true` when the SDK no longer exposes the usage request at all |
| `diagnostics` | `initMs`, `usageMs`, `unknownBucketKeys`, `limitsPayloadMissing`, plus `scopeRetried` when a token session needed a second read and `probed` / `probeCostUsd` when the paid fallback ran |

`windows[].key` is whatever the server called the bucket — `five_hour`, `seven_day`,
`seven_day_opus`, and codenames like `nimbus_quill` or `spend` that no SDK type declares. The node
walks the payload instead of reading a fixed field list, so a bucket added server-side shows up as
data rather than vanishing. Undeclared keys are listed in `diagnostics.unknownBucketKeys`.

### What to know

**`session` is not account spend.** It describes the session this node just opened, which does no work
unless the probe runs — then it is the probe's own cost. There is no API for month-to-date account
spend; for per-run cost use the query node's `total_cost_usd`.

**An empty read is not an empty plan.** `planLimitsApply: true` with `rateLimitsAvailable: false`
means the account *has* limits and this read came back without them — observed lasting several
minutes on a live Team account. `diagnostics.limitsPayloadMissing` marks exactly that case. Retry;
never treat it as unlimited. This is why `rateLimitsAvailable` follows the numbers rather than the
server's own `rate_limits_available` flag, which stayed `true` throughout.

**API key, Bedrock and Vertex sessions have no plan limits.** They are billed per token, so
`planLimitsApply` is `false`, `windows` is empty, and the account fields still tell you which login
n8n is using. Leave **Error If Limits Unavailable** off in that case.

**A `CLAUDE_CODE_OAUTH_TOKEN` session hides its own limits.** This is the usual headless and Docker
setup, and out of the box it reports `planLimitsApply: false` with no windows — on a Max or Team
account that has them. Measured against Claude Code CLI 2.1.219, the payload's own flag is

```
rate_limits_available = scopes.includes('user:inference') && scopes.includes('user:profile')
```

and for a token session the CLI *synthesises* the scope list from `CLAUDE_CODE_OAUTH_SCOPES`,
defaulting to `['user:inference']` alone. So it never asks the usage endpoint — it censors itself
before the request.

**Declare Profile Scope for Token Sessions** (on by default) handles it: the node retries the read
with `CLAUDE_CODE_OAUTH_SCOPES="user:inference user:profile"` in the CLI's environment, and
`diagnostics.scopeRetried` marks the items that needed it. Declaring the scope grants nothing — the
token still has exactly what the server issued it — so read the result to know where you stand:

| Result | Meaning |
|---|---|
| `windows` populated | the credential can read the profile; you have the numbers |
| `planLimitsApply: true`, `rateLimitsAvailable: false`, `diagnostics.limitsPayloadMissing: true` | the request was made and refused — the token cannot read the account profile |

**A `claude setup-token` token cannot read the usage endpoint.** The CLI says so itself: tokens from
`setup-token` or `CLAUDE_CODE_OAUTH_TOKEN` *"are limited to inference-only for security reasons"*. The
retry makes the CLI ask; the server declines. There is still a way to the two main windows, and two
credentials that open the full payload.

**The probe: buy the numbers for a tenth of a cent.** Every inference response carries
`anthropic-ratelimit-unified-5h-utilization` / `-reset` and the `7d` pair, and the CLI reports those as
utilisation when the endpoint is closed to the credential. **Probe With a Minimal Prompt If
Unavailable** (off by default) sends one trivial turn to Haiku so those headers exist, then reads them:

```javascript
// with the probe on, from a container whose only credential is CLAUDE_CODE_OAUTH_TOKEN
{{ $json.windows }}              // [ seven_day 20%, five_hour 11% ]
{{ $json.nextResetInSeconds }}   // 14491
{{ $json.session.totalCostUsd }} // 0.001136  ← what this read cost
{{ $json.diagnostics.probed }}   // true
```

It is the one part of this node that is not free, which is why it is opt-in and why the amount lands
in the item. A batch pays once. Only `five_hour` and `seven_day` arrive this way — `extra_usage`,
`limits` and the per-model buckets exist only in the endpoint payload.

For those, two credentials work:

- **Interactive login inside the container** — `claude auth login` there (device flow), with
  `~/.claude` on a volume so the record survives restarts. The stored record carries the real scopes.
- **Refresh-token login** — set `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` to the refresh token from an
  interactive login's credentials, plus `CLAUDE_CODE_OAUTH_SCOPES="user:profile user:inference
  user:sessions:claude_code user:mcp_servers"` (the CLI refuses the refresh-token login without it).
  This route is documented by the CLI but not verified here.

If none of the three fits, treat the node as an account-identity and liveness check on that instance
and gate on `rateLimitsAvailable` instead of on utilisation.

`subscriptionType` stays `null` on token sessions regardless: the CLI reads it from
`CLAUDE_CODE_SUBSCRIPTION_TYPE`, which the node deliberately does not invent. Set it in the container
if you want the field filled; the windows do not depend on it.

**Not being logged in looks like success.** An unauthenticated CLI answers both control requests
without an error — it just reports `tokenSource: "none"` and no plan data, which is otherwise
identical to an API-key session. Branch on `authenticated`, and note that this is the most likely
outcome when n8n runs in Docker: the container has its own `HOME`, so `~/.claude` has to be mounted
into it. With **Error If Limits Unavailable** on, the node names this case in the error and tells you
to run `claude login` as the user n8n runs as.

## Configuration Examples

### Simple Code Analysis
```javascript
{
  "operation": "query",
  "prompt": "Analyze this codebase and suggest performance improvements",
  "projectPath": "/path/to/your/project",
  "model": "sonnet"
}
```

### Advanced Database Operations
```javascript
{
  "operation": "query",
  "prompt": "Create an optimized query to find users who haven't logged in for 30 days",
  "projectPath": "/path/to/project",
  "model": "opus"
}
```

### Customer Support Automation
```javascript
{
  "operation": "query",
  "prompt": "Customer reports: 'Login button not working on mobile devices'\n\nAnalyze this issue, find the root cause, and create a fix",
  "projectPath": "/path/to/web-app",
  "model": "opus",
  "allowedTools": ["Read", "Write", "Edit", "Bash", "Grep"],
  "additionalOptions": {
    "systemPrompt": "Focus on mobile compatibility issues. Check responsive CSS and JavaScript event handlers."
  }
}
```

### Advanced Configuration with SDK Options
```javascript
{
  "operation": "query",
  "prompt": "Refactor this legacy code to use modern patterns",
  "projectPath": "/path/to/legacy-app",
  "model": "opus",
  "allowedTools": ["Read", "Write", "Edit", "MultiEdit", "Grep"],
  "disallowedTools": ["Bash"],  // Prevent command execution for safety
  "additionalOptions": {
    "permissionMode": "plan",  // Claude plans and executes no tools
    "fallbackModel": "sonnet",  // Auto-switch if Opus is overloaded
    "maxThinkingTokens": 50000,  // Allow deep reasoning for complex refactoring
    "systemPrompt": "Preserve all existing functionality while modernizing the code"
  }
}
```

With MCP configuration (`.mcp.json`):
```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "${DATABASE_URL}"]
    }
  }
}
```

## Your First Workflow

First, check the CLI is installed and authenticated on the machine n8n runs on — the node uses that
login, and there is no credential to configure in n8n:

```bash
claude --version
```

Then:

1. New workflow → add a **Manual Trigger**.
2. Add the **Claude Code** node.
3. Set **Prompt** to something read-only for a first run — `List the files in this directory and
   describe what the project does` — and **Project Path** to a real directory. In Docker, one that
   is mounted into the container.
4. Leave **Model** on Sonnet and **Output Format** on Structured. Execute.

The item that comes back carries the answer in `result`, what the run cost in `metrics`, and what
actually ran in `diagnostics` — including the model the CLI resolved to and the effort it applied,
which are not always what you asked for.

Two things worth doing before pointing it at anything that matters: set **Max Budget (USD)** in
Additional Options, and turn on **Debug Mode** for the first few runs so the n8n log shows the
message stream.

From there: the [templates](./workflow-templates/) are working workflows rather than snippets,
[`examples/`](./examples/) covers project configuration, and [MCP servers](#mcp-servers) add
database and API access.

## Notes worth knowing

### Bound what a workflow can do, in the project itself

`.claude/settings.json` in the target directory applies here exactly as it does in a terminal:

```json
{
  "permissions": {
    "allow": ["Read(*)", "Write(*)", "Bash(npm test)"],
    "deny": ["Bash(rm -rf *)"]
  }
}
```

This travels with the repository rather than the workflow, which is usually where you want it — the
constraint belongs to the codebase, not to whoever wired the node.

### Check capacity before a fan-out

Put a **Claude Code Usage** node ahead of a batch and branch on `maxUtilization`. Ten agent runs
that all fail at 100% cost more than one read that says "not now", and `nextResetInSeconds` feeds a
Wait node directly.

### Continue shares a conversation unless you say otherwise

**Continue** with no **Session ID** resolves "the most recent conversation in this directory", which
every execution on the instance shares — so two concurrent runs collide. Pass the `sessionId` from a
previous run's diagnostics to resume a specific one.

## Support

- [Issues](https://github.com/JVVeiga/n8n-nodes-claudecode/issues) — for this package. The earlier
  projects it derives from are separate; please do not file issues about this one there.
- [Repository](https://github.com/JVVeiga/n8n-nodes-claudecode)

## Development & Contributing

### Commit Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` New features (minor version bump)
- `fix:` Bug fixes (patch version bump)
- `docs:` Documentation changes
- `chore:` Maintenance tasks
- `test:` Adding or updating tests

Use `npm run commit` for an interactive commit message builder.

### Tests

```bash
npm test    # 662 tests — node:test, no framework, no extra dependencies
```

The gate for any change is `npm run lint && npm run build && npm test`.

Two things worth knowing before you touch the node:

**`tests/fixtures/` holds 48 golden fixtures** — byte-for-byte recordings of what node versions 1
and 1.1 emit, across 8 message streams and 3 output formats. If they fail, behaviour moved, and
that is the point: those versions are what every existing workflow reads. Regenerate only
deliberately with `UPDATE_GOLDEN=1 npm test`, read the diff, and say in the commit message which
fixture moved and why. Fixes to old behaviour belong in a new node version, not in the old one.

**`nodes/ClaudeCode/output/legacy.ts` is frozen.** It preserves several quirks on purpose, each
marked `FROZEN QUIRK` in the tests with the finding it corresponds to. Improvements go in
`v12.ts`.

There is also a Docker suite that runs real n8n with the node installed and asserts 39 named
behaviours against real executions — including that an attached image, PDF or document actually
reaches the model, which no unit test can prove. It lives in `scripts/e2e/`, which **is** versioned;
only what it generates (`workflows/`, `results.json`, `run-*.log`, `.pack/`) is gitignored. It costs
real API spend, so it is not part of the gate. `scripts/e2e/README.md` has the details, including
which cases to re-run before believing a failure.

### Release Process

Releases are published manually. There is no CI — validate locally first:

```bash
npm run lint
npm run build
npm test
npm publish --dry-run        # check the file list and version
```

Then bump the version and publish. npm requires a 2FA code:

```bash
npm version patch            # or minor / major
npm publish --otp=123456
git push && git push --tags
```

`npm version` writes `package.json` and creates the matching git tag.

## Credits

This package builds on earlier work, and the lineage is worth stating plainly:

1. **[Adam Holt](https://github.com/holt-web-ai)** created the original n8n Claude Code node —
   [holt-web-ai/n8n-nodes-claudecode](https://github.com/holt-web-ai/n8n-nodes-claudecode).
2. **[John Lindquist](https://github.com/johnlindquist)** forked and maintained it —
   [johnlindquist/n8n-nodes-claudecode](https://github.com/johnlindquist/n8n-nodes-claudecode).
   This package's Claude Agent SDK migration started from his version.
3. This package is maintained by **[João Veiga](https://github.com/JVVeiga)** —
   [JVVeiga/n8n-nodes-claudecode](https://github.com/JVVeiga/n8n-nodes-claudecode). It has since
   diverged: its own architecture, versioning and release line.

The idea, the original node structure, and the n8n integration groundwork are theirs. Thanks to both.

## License

MIT, throughout the lineage. The original copyright notice is kept intact in
[LICENSE.md](LICENSE.md).
