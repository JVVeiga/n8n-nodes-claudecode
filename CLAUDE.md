# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Versioning & Release Process

This project uses conventional commits. Releases are **manual** — there is no
CI and no semantic-release. Publishing happens from a developer machine.

### Commit Conventions
- `feat:` New features (triggers minor version bump)
- `fix:` Bug fixes (triggers patch version bump)
- `perf:` Performance improvements (triggers patch version bump)
- `docs:` Documentation changes (no version bump)
- `chore:` Maintenance tasks (no version bump)
- `test:` Test updates (no version bump)
- `BREAKING CHANGE:` in commit body (triggers major version bump)

### Manual Release Process
1. Make changes following conventional commit format
2. Validate locally: `npm run lint && npm run build && npm publish --dry-run`
3. Bump the version and tag: `npm version patch|minor|major`
4. Publish: `npm publish --otp=<code>` (the account requires 2FA)
5. Push the commit and the tag: `git push && git push --tags`

The package is `@joaoveiga/n8n-nodes-claudecode`. Nothing publishes on push —
there are no GitHub Actions workflows in this repository.

### Interactive Commits
Use `npm run commit` to use commitizen for guided commit creation.

### What is NOT here
No CI, no GitHub Actions, no semantic-release. The `@semantic-release/*` packages were in
devDependencies with no config and no workflow to run them; they were removed. Publishing is the
five manual steps above. Package contents are decided by `files` in package.json — there is no
`.npmignore` (it was a no-op next to `files`, and its stale entries gave false confidence).

## Common Commands

### Development
- `npm test` - Compile and run the test suite (see [Testing](#testing))
- `npm run build` - Build the project (format check, clean dist, compile, copy icons)
- `npm run lint` - Run ESLint to check code quality
- `npm run lintfix` - Auto-fix linting issues where possible
- `npm run format` - Format code using Prettier
- `npm run dev` - Run TypeScript compiler in watch mode

**The gate for any change**: `npm run lint && npm run build && npm test`. `npm run build` runs
`format:check`, so an unformatted file fails it.

Run it exactly like that. **Do not pipe the steps** — `npm run lint | tail -1` makes the exit code
the pipe's, which is 0 even when eslint failed, so an `&&` chain sails past a red lint. Four commits
shipped with a lint error that way. If you need to shorten the output, redirect and check `$?`:
`npm run lint >/dev/null 2>&1; echo $?`.

### n8n Integration
- Install locally: `npm link` then `n8n start` to test the node
- The node appears in n8n UI under "Claude Code" category
- Debug output available when Debug option is enabled in node parameters

## Architecture Overview

Two n8n nodes over the Claude Agent SDK. Both are thin shells; the work is in named modules.

```
nodes/
  shared/                      used by both nodes
    projectPath.ts             the cwd check, plus its "mount it in Docker" description
    debug.ts                   one debug gate — no `if (debug)` blocks in business logic
    sdkMessage.ts              narrowing helpers over SDKMessage; the only casts live here
    problem.ts                 a validation failure, returned rather than thrown
  ClaudeCode/
    ClaudeCode.node.ts         the INodeType class + runItems(ctx, deps)
    attachments/               n8n binary data -> content blocks, or files on disk
      types.ts                 AttachmentSpec, Attachment, Route, AttachmentPlan
      mime.ts                  the ENTIRE routing policy — which files inline, which stage
      name.ts                  filename derivation, sanitizing, uniquifying
      collect.ts               getBinaryDataBuffer + validation — the only impure reader
      plan.ts                  Attachment[] -> ContentBlockParam[] + staging list (pure)
      stage.ts                 the temp dir, and the cleanup the node must run
    description/               the declarative schema — pure data, no branching
      properties.ts            top-level parameters
      additionalOptions.ts     the Additional Options collection
      models.ts                MODELS — the ONE model list, feeding both selectors
      toolOptions.ts           BUILT_IN_TOOL_OPTIONS, feeding all three tool selectors
    types.ts                   ClaudeCodeParams, RunOutcome, and SdkOptions re-exported
    params.ts                  readParams — the ONLY place that calls getNodeParameter
    config.ts                  parameters -> SDK options, as an ordered applier table
    runner.ts                  runs the query, owns both timers, reports timeouts
    messageLog.ts              per-message debug logging
    diagnostics.ts             evidence of what actually ran
    output/
      resultText.ts            "what does this run say" — the six-rung fallback ladder
      legacy.ts                FROZEN typeVersion 1 / 1.1 shapes
      v12.ts                   the 1.2 unified envelope
      index.ts                 buildOutputItem — routes by typeVersion
    errors.ts                  the four failure paths, as data
    timeout.ts                 run metrics, grace window, timeout payload/messages
    promptStream.ts            the prompt as an AsyncIterable
  ClaudeCodeUsage/
    ClaudeCodeUsage.node.ts    the class + readUsageItems(ctx, deps)
    description.ts             its schema
    readUsage.ts               spawns the CLI and reads usage (the only impure module)
    usage.ts                   window/account normalisation
```

### Where to make a change

| Task | File |
|---|---|
| Add or change a node parameter | `description/properties.ts` or `description/additionalOptions.ts` |
| Add a model | `description/models.ts` — both selectors generate from it |
| Expose a new SDK option | one entry in the `APPLIERS` table in `config.ts` |
| Support a new file type, or change a route | `attachments/mime.ts` — the tables are the policy |
| Offer a new extension in the Allowed Extensions filter | `description/extensionOptions.ts` |
| Change what the model is told about staged files | `attachments/plan.ts` (`stagedHintBlock`) |
| Change what a run reports | `diagnostics.ts` |
| Change the output shape | `output/v12.ts` — **never** `output/legacy.ts` |
| Change stop/timeout behaviour | `runner.ts` |
| Change a failure item | `errors.ts` |

### Rules that are not obvious

- **`params.ts` is the only place that reads node parameters.** Everything downstream takes plain
  data, which is why it is all unit-testable.
- **`output/legacy.ts` is frozen.** It is what typeVersions 1 and 1.1 emit, held byte-for-byte by
  48 golden fixtures. It preserves several quirks deliberately, each marked `FROZEN QUIRK` in the
  tests with the finding it corresponds to. Fixes go in `v12.ts`.
- **`runner.ts` reports a timeout, it does not throw one.** The caller decides whether that becomes
  an error item or an exception. This is what keeps `execute()` free of nested try/catch.
- **Interrupting is what makes the SDK account for a run.** `interrupt()` yields a result message
  with the real cost; a bare `abort()` yields nothing, which is why a killed run reports zeroes.
- **A prompt turn can be content blocks, not only a string.** `SDKUserMessage.message` is the
  Anthropic SDK's `MessageParam`, so `content` takes `ContentBlockParam[]` — an image, a PDF or a
  document reaches the model directly, with no filesystem and no `Read` tool. Verified by the three
  spikes in `.specs/features/attachments/spikes/` before any of it was built. This is the whole
  reason the attachment feature is not a temp-directory-and-`--add-dir` copy of the alternatives.
- **`diagnostics.attachments` is absent, not null, when there were no attachments.** `JSON.stringify`
  drops an `undefined` field but a deep-equal sees an own property set to `undefined`, so the field is
  added by a conditional spread. That is what keeps the 48 golden fixtures byte-identical and is why
  attachments needed no new typeVersion.
- **`attachments/collect.ts` is the only module that reads a buffer**, the same role `readUsage.ts`
  plays for the Usage node. `mime.ts` and `plan.ts` never touch n8n or a disk, which is why the
  routing policy and the exact blocks sent are unit-testable.
- **A skip and a failure are different things, on purpose.** A size cap or a missing property
  refuses something the user asked for, so it fails the item. The **Allowed Extensions** filter is
  the user saying which types they want, so excluding the rest is obedience, not silence — it never
  fails anything. What keeps that honest is that every skip lands in
  `diagnostics.attachments.skipped` and in the debug log. The filter also runs on metadata *before*
  any buffer is read and *before* the count check, so an ignored file is neither loaded into memory
  nor able to trip `maxAttachmentCount`.
- **`ROUTABLE_EXTENSIONS` in `mime.ts` must stay a subset of `EXTENSION_OPTIONS`.** A test asserts
  it. If the router can name a type, the filter has to be able to select it — otherwise a user is
  handed a file they have no way to filter on and the only escape is turning the filter off.
- **Nodes cannot be constructor-injected.** n8n calls `execute.call(executionContext)`, so `this`
  is the context and instance fields are unreachable. Dependencies go through the exported
  `runItems(ctx, deps)` / `readUsageItems(ctx, deps)` — that is the seam tests use.

## Node Versions

Observable behaviour changes are gated behind `description.version`. A node keeps the typeVersion
it was created with, so raising `defaultVersion` only affects newly added nodes.

| | What it changed |
|---|---|
| 1 | the original |
| 1.1 | Timeout Wrap-Up Grace defaults to 60s; failure items reshaped to reach the error output |
| 1.2 | one output envelope for all three formats (current default) |

**Never remove a version** — a stored workflow pinned to it would stop loading. **Never change what
an existing version emits**; add a new one.

## Testing

```bash
npm test                                    # 662 tests, node:test, no framework
npm run lint && npm run build && npm test   # the gate for any change
UPDATE_GOLDEN=1 npm test                    # regenerate the golden fixtures — see below
```

### The golden fixtures

`tests/fixtures/` holds 48 recordings of exactly what the node emits for typeVersions 1 and 1.1,
across 8 message streams and 3 output formats. They are compared byte-for-byte.

**If they fail, behaviour moved.** That is the point. Only regenerate deliberately:

1. Run `UPDATE_GOLDEN=1 npm test`.
2. Read the `git diff`. Every changed byte is a behaviour change to an existing workflow.
3. If it was not intended, revert and fix the code instead.
4. If it was, the commit message has to say which fixture moved and why.

They are in `.prettierignore` — they are `JSON.stringify` output compared with `assert.equal`, so
reformatting them breaks the suite.

### End-to-end, in Docker

`scripts/e2e/` brings up real n8n in Docker
with the node installed and asserts 39 named behaviours against real executions:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)
npm run e2e:up && npm run e2e:run && npm run e2e:verdict
```

The node must be installed **inside** the container: the SDK ships platform-specific CLI binaries,
so a macOS-host install fetches the darwin build and cannot run on linux. `e2e:run` costs real API
spend — the timeout cases run real agent turns, budget under US$1 for a full pass.

`readUsage.ts` has no unit tests on purpose: it spawns a real CLI, and this suite covers it.

The four attachment cases (case40-43) are the only checks that prove a file reaches the model at
all — the unit tests prove which content blocks get built, not that the CLI and API accept them.
case40 asks for the colour of a generated PNG and case42 asks for a value on the last row of a
staged file, so neither can be answered without the bytes.

## Configuration Examples

The `examples/` directory contains sample configurations:
- **simple-project/**: Basic setup without MCP servers
- **project-with-mcp/**: Full MCP server configuration example

Key configuration files:
- `.mcp.json`: Defines available MCP servers (project root)
- `.claude/settings.json`: Team-shared settings
- `.claude/settings.local.json`: Personal settings (gitignored)

When using Project Path, Claude Code automatically loads these configurations from the specified directory.