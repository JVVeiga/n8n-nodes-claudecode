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

**Sessions you can resume.** A **Session ID** on Continue, so concurrent executions stop sharing
one conversation.

**One output envelope.** The three output formats share a shape; the format picks which optional
sections you get. See [Output Formats](#output-formats).

## Contents

**Start here** — [Install](#install) · [Your First Workflow](#your-first-workflow) · [Templates](./workflow-templates/) · [What people build with it](#what-people-build-with-it)

**Reference** — [Features](#features) · [Timeouts](#timeouts) · [Output Formats](#output-formats) · [Usage & Plan Limits](#usage--plan-limits) · [Node versions](#node-versions) · [Configuration Examples](#configuration-examples)

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

All three get the diagnostics, the session ID and the self-describing error message.

To move an existing node forward, delete it and add a fresh one — there is no in-place upgrade,
because silently changing a running workflow's output is exactly what the versioning prevents.

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
npm test    # 465 tests — node:test, no framework, no extra dependencies
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

There is also a Docker suite that runs real n8n with the node installed and asserts 23 named
behaviours against real executions. It lives in `scripts/e2e/` and is untracked — a working
instrument rather than a deliverable. `CLAUDE.md` has the details.

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
