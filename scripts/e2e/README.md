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
| `n8n-up.sh` | host | build → pack → install in container → start n8n → import cases |
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

## The attachment cases

`case40`–`case43` are the only cases whose input is binary, so they have a Code node in front of
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

These four ignore `fixture-project/`, and are cheap: one short turn each.

## Reading a failure

`run-cases.mjs` writes `run-<slug>.log` per case — the full n8n CLI output including the
debug lines. When `verdict.mjs` reports a FAIL, that log is the first place to look;
`results.json` holds the already-extracted item JSON, error context and output branch
index for the same case.
