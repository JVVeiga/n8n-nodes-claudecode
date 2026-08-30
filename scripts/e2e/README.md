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
| `fixture-project/` | mounted as `/workspace` | six 126-line TS files; described one at a time, they overrun a *tight* timeout |
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
