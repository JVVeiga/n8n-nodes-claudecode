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

There is nothing to migrate. If you want an existing node on 1.2, delete it and add a fresh one —
there is no in-place upgrade, because silently changing a live workflow's output is what the
versioning exists to prevent.

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
