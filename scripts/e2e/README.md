# E2E rig — validating the node in real n8n, in Docker

This directory is versioned. What it generates is not: `workflows/`, `results.json`,
`run-*.log` and `.pack/` are gitignored, because they change on every run and would put
600KB of churn in every diff.

It is versioned because it encodes findings that cost real work to discover — read the
comments in `n8n-up.sh` and `gen-workflows.mjs` before changing either — and because it
was already lost once to a wiped scratch directory when it was not.

## Why Docker at all

The Claude Code SDK ships platform-specific CLI binaries as optional dependencies.
Installing the packed node on the macOS host fetches the **darwin** build, which cannot
run inside a linux n8n container. So the tarball is installed *inside* the container,
which pulls the linux CLI.

## Credentials

The host keeps Claude credentials in the macOS Keychain, unreadable from a linux
container. Export a token before running:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)
# or
export ANTHROPIC_API_KEY=sk-ant-...
```

`claude setup-token` renders a full-screen TUI, so command substitution captures ~60
lines of prompts and escapes with the token buried inside — the CLI then rejects it with
*"it contains a line break at character 56"*. `n8n-up.sh` recovers the token from that
mess automatically and reports only its length. It is never written to a file, an image
layer, or the repo — only passed as a run-time `-e` flag.

**Do not** bake a token into a container's environment permanently: `docker inspect`
exposes it to anything on the machine that can reach the Docker socket.

## Run order

```bash
# 1. build, pack, install in container, import the case workflows
npm run e2e:up

# 2. execute every case, extract the node's output, write results.json
npm run e2e:run

# 3. evaluate the named assertions against results.json
npm run e2e:verdict
```

Step 2 costs real API spend — the timeout cases run real agent turns. Budget under
US$1 for a full pass. Run a subset by name:

```bash
E2E_CONTAINER=n8n-cc-e2e node scripts/e2e/run-cases.mjs case04 case07
```

## Environment

| Var | Default | Notes |
|---|---|---|
| `E2E_PORT` | `5690` | 5678 is held by `machine-n8n`, 5688 by `n8n-cc-test2` |
| `E2E_CONTAINER` | `n8n-cc-e2e` | must match between `e2e:up` and `e2e:run` |
| `E2E_VOLUME` | `n8n_cc_e2e` | recreated each run unless `E2E_KEEP_DATA=1` |
| `E2E_IMAGE` | `n8nio/n8n:latest` | |
| `E2E_KEEP_DATA` | `0` | `1` reuses the volume — keeps imported workflows and execution history |

## Files

| File | Runs where | Purpose |
|---|---|---|
| `n8n-up.sh` | host | build → pack → install in container → start n8n → import credentials → import cases |
| `gen-workflows.mjs` | host | generates one workflow JSON per case into `workflows/` |
| `run-cases.mjs` | host | `n8n execute` per case, parses the node's output, writes `results.json` |
| `verdict.mjs` | host | named assertions over `results.json`; prints PASS/FAIL and a tally |
| `fixture-project/` | mounted as `/workspace` | six 126-line TS files under `src/` (described one at a time, they overrun a *tight* timeout), plus `verify/slug.ts` for case87 and `data/stock.csv` for case89-91 |
| `kit-repo.sh` | container | builds case88's git repo at `/home/node/kit-repo` (fixed SHAs; its header is the expected diff) |
| `ids.js` | container | workflow id ↔ name listing, read from the sqlite DB |
| `list-wf.js` | container | per-workflow summary: typeVersion, timeout, grace, format, onError |
| `last-exec.js` / `last-execs.js` | container | inspect the most recent execution(s) |
| `activate.js` | container | activates the `case10 PRODUCER` workflow (the trigger case) |
| `patch-session.js` / `read-exec.js` | container | patch a case's Session ID; read one execution's output |

Generated, safe to delete: `workflows/`, `results.json`, `run-*.log`, `.pack/`.

**The fixture project's size is load-bearing, and not in the direction it looks.** Six 126-line
files, not the six 2.5k-line files an earlier version of this file claimed. Measured on
`claude-sonnet-5`, describing them one at a time runs 19–45s — so the timeout cases are set well
under that floor. Paired with the 45–60s timeouts they originally had, the prompt *finished* and four
cases asserted a timeout that never happened. Keep the timeouts tight, or re-measure when the fixture
or the model changes.

## The authentication cases

`case52`–`case54` cover the Authentication parameter, and they are the only checks that prove a
credential's environment variable actually reaches the CLI and **overrides** the host login. The unit
tests prove which environment gets built; they cannot prove the CLI honours it.

`n8n-up.sh` imports the credentials they reference before importing the workflows. Three of them:

| Credential | Id | Source |
|---|---|---|
| `E2E Decoy API Key (invalid on purpose)` | `e2ecreddecoy0000` | hardcoded, worthless, always imported |
| `E2E Claude Code OAuth Token` | `e2ecredoauth0000` | `$CLAUDE_CODE_OAUTH_TOKEN`, when exported |
| `E2E Claude Code API Key` | `e2ecredapikey000` | `$ANTHROPIC_API_KEY`, when exported and no token |

The ids are fixed and duplicated in `gen-workflows.mjs`'s `CREDENTIALS`. A workflow references a
credential **by id**, so a generated id on one side and a random one on the other imports cleanly and
then fails at run time with "credentials not found".

`n8n import:credentials` needs a file, so the operator's token is written inside the container (piped
in on stdin, `umask 077`) and deleted in the same command. It never reaches the host filesystem, an
image layer or the repo.

**`case53` is the load-bearing one.** The container is logged in and every other case runs on that
login, so a run that fails to authenticate on a deliberately invalid credential can only have been
running on the credential — which means the credential replaced the host's. A passing `case52` on its
own would not distinguish "the credential worked" from "the credential was ignored and the host
answered". `case52` is generated **only when the shell running `gen-workflows.mjs` can supply a real
credential**, and the generator says so loudly when it cannot. That matters because
`n8n import:workflow` never deletes: regenerating without the token drops `case52` from
`workflows/` while leaving the previous one in the database, and the verdict then reports SKIP as if
the rig had a gap rather than the generator having been run in the wrong shell.

## The attachment cases

`case40`–`case47` are the only cases whose input is binary, so they have a Code node in front of
Claude Code that produces it — the same `{data: <base64>, mimeType, fileName}` shape an HTTP Request
or Monday node emits, which is what makes them exercise `getBinaryDataBuffer` for real. The bytes are
generated in `gen-workflows.mjs` (including the PNG, byte by byte), so nothing binary is committed
and the assertion lives next to the data it asserts on.

They are also the only checks that prove a file reaches the *model*. The unit tests prove which
content blocks get built; only these prove the CLI and the API accept them, and that a staged
directory in `os.tmpdir()` is reachable from inside the container.

Each is designed so it cannot be answered without the bytes: `case40` asks the colour of a generated
PNG, `case41` a CSV value that exists nowhere else, and `case42` a value on the **last** row of a
staged file — so a model inferring from the hint block instead of reading the file gets it wrong.
`case43` asserts a rejected attachment costs nothing, because `collectAttachments` fails before
`query()` is ever called.

`case44`–`case47` cover what one file on one route cannot: the Attach All toggle with three files
at once (proving property-name ordering, and that an inline file and a staged file coexist in one
request), a PDF, the size cap, and — the one that matters most — a staged file under a
**Restrict Built-in Tools** list that omits `Read`. Without the applier injecting `Read`, that run
answers `CANNOT_READ` and still reports success: a green execution with a wrong answer. It is the
only requirement whose entire purpose is preventing a false green, and the only one that can only
break in a real container.

These eight ignore `fixture-project/`, and are cheap: one to three turns each, ~$0.24 for all of
them.

Two behaviours stay unit-only on purpose: the MIME fallback chain (declared type -> extension ->
UTF-8 sniff) and an image over the 5 MB ceiling staging instead of inlining. Both are pure
functions of `(mimeType, bytes)` with no environment dependency, which is the whole reason
`mime.ts` takes no I/O.

## The Claude Code Agent cases

`case80`–`case86` drive the Agent root node on Haiku at low effort (~US$0.25 for all nine). What
only a real n8n shows, and so what they assert on:

- `case80` wires one tool of each shape the Agent must bridge: a Code Tool with a JSON-schema
  input, a Call Workflow Tool, an HTTP Request node used as a tool, and an MCP Client Tool — which
  arrives as a *toolkit* — pointed at an MCP Server Trigger in the same instance. Its two targets
  (`case80wftarget00`, `case80mcpserver0`) must be **published**, and the running server only
  serves `/mcp/e2e-case80` after a **restart** that follows the publish; `n8n-up.sh` does both and
  probes the route with a real `initialize`.
- `run-cases.mjs` records `nodeRuns` — every node's own run log. A tool node with a run, or a
  Subagent node with an `ai_agent` run (`case83`), is the evidence the sub-node was used rather than
  imitated by the model.
- `case84a`/`case84b` share a literal session key. `run-cases.mjs` deletes that key's session from
  the container before `case84a`, so it is a real first use (`created`) on every pass and `case84b`
  resumes what it created.
- `case81b`'s impossible schema ends one of two ways, at the model's whim: it gives up in prose (a
  success with no object), or it exhausts the CLI's five retries, after which the SDK also throws.
  Both must be a `structured_output` failure; the second once came out as an `execution_error`.
- `editor83` is never executed: it is the canvas a browser uses to check that a Subagent cannot be
  dragged onto the n8n AI Agent's Tool input, and where NDV parameters get toggled. **A browser
  must never edit a `case…` workflow**: n8n 2.x autosaves, and an NDV toggle saved mid-sequence
  once left case83 on Session = Resume with no key, failing the next run. A browser that exits
  without closing also leaves an edit lock ("Editing in another tab") that the next one must take
  over with "Edit here".

- `case87` is Verification. `fixture-project/verify/slug.ts` sits outside `src/` on purpose
  (a case asserts exactly six files there). The main run is told to report one true and one false
  claim about it verbatim, without tools; only the verification turn, which forks the session,
  can refute the false one, and only by reading the file. Its `verification.costUsd` is the
  verification's own share: a forked result's `total_cost_usd` already includes the first run. It
  reports usage to the collector, and exactly one report must carry the item's combined total.
  That the fork leaves a keyed session untouched is covered by unit tests, not here.

- `case88` is the Code Review Kit and calls no model, so it costs nothing. Its repo is built by
  `kit-repo.sh` inside the container (by `n8n-up.sh`), never under `/workspace`: that is a bind
  mount of `fixture-project/`, and a `.git` there would land in the host checkout. Fixed identities
  and dates make the SHAs reproducible, so the verdict names the merge base. Fingerprint stability
  is proven end to end with two extra branches: `kit-shifted` inserts three lines above the anchor,
  `kit-edited` rewords it. `run-cases.mjs` records every `Kit …` node's whole item under `kitRuns`.

## The background-subagent cases

`case89`–`case91` pin Claude Code 1.4, the Chat Model 1.1 and the Task Tool 1.1, and ask for one
general-purpose subagent with `run_in_background` set, which reads a sku from
`fixture-project/data/stock.csv` — plain data: a subagent refused to repeat a codeword from a file
that phrased it as an instruction. The CLI then writes an interim result ("waiting on the
subagent") before the final one. Each case asserts the answer carries `SKU=KESTREL-5082` and no
waiting text, and — from the debug log, which `run-cases.mjs` counts into `backgroundRun` — that a
subagent reported back and more than one result was written, so a pass that never backgrounded
fails instead of passing trivially. In `case91` the outer Chat Model cannot delegate and logs
nothing, so the counts are the tool's own. About US$0.20 for the three.

## Retry a timing-sensitive failure before investigating it

The timeout cases (`case01`, `case02`, `case03`, and `case08` which resumes case01's session)
assert that *work completed* inside a short window — a session id was captured, a cost was
reported, a wrap-up finished. That makes them sensitive to API latency in a way no other case is,
and the window is small by necessity: too loose and the prompt finishes and the case stops testing
anything at all (see the fixture-project note above).

Observed on 2026-08-28, one full pass, unchanged code:

| Case | Slow window | Immediate retry |
|---|---|---|
| `case21` (a one-word "pong", 120s timeout) | 319.1s — **timed out** | 17.9s — success |
| `case08` | 528.1s — error | 17.1s — success |
| `case02` / `case03` | 0 assistant turns, no session id | 17.1s / 16.4s, session captured |
| `case01` | no session id, cost unknown | 40.1s, session captured |

Six checks failed, then all six passed on retry. The node reported honestly throughout — "timed out
after 15s, 0 assistant turns, cost unknown, no session id" is exactly what it is designed to say
when a kill yields nothing — so the FAILs were true statements about a slow API, not about the code.

**So: on a FAIL in `case01`/`02`/`03`/`08`, re-run just those cases before reading a single line of
node source.** `node scripts/e2e/run-cases.mjs case01 case02 case03 case08` — results.json merges,
so a retry updates in place and the other cases are left alone. If it fails twice, then investigate.

The attachment cases and the `case04*`/`case20*` cases have no such dependency: they assert what an
item contains, not how fast it arrived.

## Reading a failure

`run-cases.mjs` writes `run-<slug>.log` per case — the full n8n CLI output including the
debug lines. When `verdict.mjs` reports a FAIL, that log is the first place to look;
`results.json` holds the already-extracted item JSON, error context and output branch
index for the same case.
