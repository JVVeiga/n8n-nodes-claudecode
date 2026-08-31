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

Five n8n nodes over the Claude Agent SDK: two main-flow nodes, and three sub-nodes for n8n's AI
Agent (a chat model and two tools). Every one of them is a thin shell; the work is in named
modules, and anything two nodes would otherwise copy lives in `shared/`.

```
credentials/                   the two n8n credential types
  ClaudeCodeApi.credentials.ts            an Anthropic API key -> ANTHROPIC_API_KEY
  ClaudeCodeOAuthTokenApi.credentials.ts  a Claude Code token -> CLAUDE_CODE_OAUTH_TOKEN

nodes/
  shared/                      used by every node
    projectPath.ts             the cwd check, plus its "mount it in Docker" description
    auth.ts                    the ENTIRE auth policy — the scrub list and the env it builds
    readAuth.ts                the only impure half: the selector + getCredentials()
    authDescription.ts         the Authentication selector and credentials[], shared by both nodes
    debug.ts                   one debug gate — no `if (debug)` blocks in business logic
    sdkMessage.ts              narrowing helpers over SDKMessage; the only casts live here
    problem.ts                 a validation failure, returned rather than thrown
    abort.ts                   attach/detach an operation's AbortController to outer signals
    preview.ts                 truncation for log and error text
    subNodeParams.ts           the run params every sub-node reads — ONE copy of the defaults
    runOptions.ts              the Options collection every sub-node offers, as factories
    toolRunLog.ts              toToolName + the addInputData/addOutputData pair for ai_tool
    usageReport.ts             the collector payload and run_key — pure, no n8n
    reportUsage.ts             the impure half: builds the reporter from a supply context
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
      metrics.ts               the `metrics` object — v1.2 output and every sub-node report
      v12.ts                   the 1.2 unified envelope
      index.ts                 buildOutputItem — routes by typeVersion
    errors.ts                  the four failure paths, as data
    timeout.ts                 run metrics, grace window, timeout payload/messages
    promptStream.ts            the prompt as an AsyncIterable
  ClaudeCodeChatModel/         a Chat Model sub-node for n8n's AI Agent (ai_languageModel)
    ClaudeCodeChatModel.node.ts the class + supplyChatModel(ctx, deps, itemIndex)
    description.ts             its schema — inputs: [], outputs: [AiLanguageModel]
    params.ts                  the ONLY getNodeParameter reader for this node
    model.ts                   ClaudeCodeChat extends BaseChatModel — one _generate = one run
    messages.ts                BaseMessage[] -> { system, prompt } (history flattened, pure)
    toolBridge.ts              the Agent's tools -> one in-process MCP server (tool.invoke)
    result.ts                  SDKMessage[] -> text/usage/tool_calls (the R16 passthrough)
  ClaudeCodeTool/              Claude Code as a REAL ai_tool sub-node (fixed {task} schema)
    ClaudeCodeTool.node.ts     the class + supplyClaudeCodeTool(ctx, deps, itemIndex)
    description.ts             its schema — name claudeCodeTaskTool (claudeCodeTool is the
                               auto-wrap n8n synthesizes; never reuse that name)
    params.ts                  the ONLY getNodeParameter reader for this node
    tool.ts                    DynamicStructuredTool over buildQueryOptions/runQuery; text out,
                               never throws — a tool error is data for the calling model
  ClaudeCodeUsageTool/         the plan read as a zero-argument ai_tool sub-node
    ClaudeCodeUsageTool.node.ts the class + supplyClaudeCodeUsageTool(ctx, deps, itemIndex)
    description.ts             its schema — name claudeCodePlanUsageTool (same trap as above)
    tool.ts                    the Usage node's read escalation over readUsage/normalizeUsage
  ClaudeCodeUsage/
    ClaudeCodeUsage.node.ts    the class + readUsageItems(ctx, deps)
    description.ts             its schema
    readUsage.ts               spawns the CLI and reads usage (the only impure module)
    escalate.ts                the read → scope-retry → paid-probe ladder, shared with the tool
    usage.ts                   window/account normalisation
```

### Where to make a change

| Task | File |
|---|---|
| Add or change a node parameter | `description/properties.ts` or `description/additionalOptions.ts` |
| Add a model | `description/models.ts` — both selectors generate from it |
| Expose a new SDK option | one entry in the `APPLIERS` table in `config.ts` |
| Add an authentication mode (Bedrock, a gateway) | `shared/auth.ts` — `ENV_VAR_FOR_MODE` — plus one option in `shared/authDescription.ts` and a credential class |
| Support a new file type, or change a route | `attachments/mime.ts` — the tables are the policy |
| Offer a new extension in the Allowed Extensions filter | `description/extensionOptions.ts` |
| Change what the model is told about staged files | `attachments/plan.ts` (`stagedHintBlock`) |
| Change what a run reports | `diagnostics.ts` |
| Change the output shape | `output/v12.ts` — **never** `output/legacy.ts` |
| Change the `metrics` object | `output/metrics.ts` — it feeds v1.2 output AND every sub-node's usage report |
| Change stop/timeout behaviour | `runner.ts` |
| Change a failure item | `errors.ts` |
| Change how the Chat Model maps Agent messages | `ClaudeCodeChatModel/messages.ts` |
| Change how the Agent's tools reach Claude Code | `ClaudeCodeChatModel/toolBridge.ts` |
| Change the Task tool's contract or failure text | `ClaudeCodeTool/tool.ts` |
| Change the Usage tool's report | `ClaudeCodeUsageTool/tool.ts` |
| Change how a usage read escalates | `ClaudeCodeUsage/escalate.ts` — node and tool share it |
| Change what a sub-node reports, or its run_key | `shared/usageReport.ts` (pure) / `shared/reportUsage.ts` (the n8n call) |
| Add an option to every sub-node | `shared/runOptions.ts`, then compose it in each description |
| Change a sub-node's run defaults | `shared/subNodeParams.ts` — never one node's params.ts |

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
- **The auth parameter is called `authSource`, and `authentication` is a name you cannot use.** n8n
  reserves it: the editor never renders a parameter by that name as an ordinary field, it absorbs it
  into the credentials UI and builds the dropdown from `credentials[]` — one option per credential
  type. A mode that maps to no credential (`host`) is not expressible that way, so n8n drew nothing
  at all and a user could never leave Host from the editor. Every unit test and all three E2E cases
  passed regardless, because they set the parameter in workflow JSON and none of them goes through
  the editor. **A node parameter that changes what the editor shows is not covered by this repo's
  test suite — drive the real UI.**
- **Authentication is an environment, not a patch.** `Options.env` REPLACES the CLI subprocess's
  environment rather than merging into it, so host mode leaves the option **absent** — a spread copy
  of `process.env` would behave identically today while making the default path structurally
  different from the one every stored workflow runs. Credential mode spreads `process.env`, deletes
  **all seven** variables in `AUTH_ENV_VARS` (copied from the SDK's own `Tw` constant), then sets
  one. Deleting only the opposite variable would let a container's global `ANTHROPIC_API_KEY`
  authenticate a run the user pointed at an OAuth token — and that run would *succeed*, which is the
  worst shape the bug could take.
- **`diagnostics.auth` is absent, not null, for a host run** — the same conditional spread as
  `attachments`, and for the same reason: it is what kept the 48 golden fixtures byte-identical and
  is why authentication needed no new typeVersion.
- **`readAuth` is separate from `params.ts` because `readParams` is synchronous.**
  `getCredentials()` returns a promise. The selection reaches `config.ts` through `deps`, the way
  `stagedDir` does — a runtime fact rather than a parameter.
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
- **A tool sub-node's schema must be JSON Schema, never a zod object from this package's copy.**
  n8n's `normalizeToolSchema` branches on `tool.schema instanceof ZodType` against **its own**
  zod, which an instance from ours never satisfies (measured for `zod/v4` and `zod/v3` alike). It
  then runs `convertJsonSchemaToZod` over our zod object and produces a mangled `ZodDefault`, so
  the tool the model is offered no longer matches the tool that exists and the call fails before
  the handler runs — silently, with the model inventing an explanation. Plain JSON Schema puts
  n8n on its own happy path. Pinned by a test asserting the schema is not a zod instance.
- **A sub-node's output cannot be read by an expression.** It is not on the `main` chain, so
  `$('Claude Code Chat Model').item.json.metrics` resolves against nothing — measured, and it is
  why usage leaves by calling a workflow (`executeWorkflow` is inherited by the supply context)
  rather than by being picked up downstream. Two n8n rules govern that call, both measured:
  the target must be **published** (n8n 2.x resolves the published version; setting `active` in
  the database changes nothing), and its Execute Workflow Trigger must accept the payload —
  declared fields or `passthrough`, otherwise "At least 1 field is required".
- **`supplyData` is called ONCE per node, not once per item.** Measured (e2e case72: an Agent fed
  two items produced two reports from one supplied instance, both carrying `itemIndex` 0, the
  sequence counter separating them). The signature takes an `itemIndex` and n8n may one day use
  it, which is why `run_key` carries it too — but a counter created in `supplyData` numbers every
  call of the execution, which is what the key relies on today.
- **Reporting must never cost the caller their answer.** `createUsageReporter` calls with
  `doNotWaitToFinish` and swallows every failure into the debug log. A collector that is down
  loses a metric; a run that dies because logging failed loses what the user paid for.
- **Nodes cannot be constructor-injected.** n8n calls `execute.call(executionContext)`, so `this`
  is the context and instance fields are unreachable. Dependencies go through the exported
  `runItems(ctx, deps)` / `readUsageItems(ctx, deps)` / `supplyChatModel(ctx, deps, itemIndex)` —
  that is the seam tests use.
- **The Chat Model node is duck-typed on purpose.** n8n's Tools Agent accepts any object whose
  `lc_namespace` includes `chat_models` and that has `bindTools` (verified in the running
  container, `@n8n/ai-utilities` `guards.js`), and every seam it touches afterwards is duck-typed
  too. `@langchain/core` and `zod` are **peerDependencies**: n8n strips peers on community
  install and resolves them to its own single copy via NODE_PATH; a plain `npm install` (the e2e
  path) auto-installs a nested copy, which the duck-typing tolerates. Do not "fix" them into
  dependencies. The Agent's tools are executed by Claude Code in-process through one
  `createSdkMcpServer` bridge (`mcp__n8n__<tool>`), so the Agent sees a single model turn — HITL
  tools and Return Intermediate Steps are documented as unsupported. Facts and decisions:
  `.specs/features/chat-model/spec.md`.

## Node Versions

Observable behaviour changes are gated behind `description.version`. A node keeps the typeVersion
it was created with, so raising `defaultVersion` only affects newly added nodes.

| | What it changed |
|---|---|
| 1 | the original |
| 1.1 | Timeout Wrap-Up Grace defaults to 60s; failure items reshaped to reach the error output |
| 1.2 | one output envelope for all three formats |
| 1.3 | Attach All Binaries set to Auto means ON (current default) |

**Never remove a version** — a stored workflow pinned to it would stop loading. **Never change what
an existing version emits**; add a new one.

**Removing `usableAsTool` deletes a node type.** n8n synthesizes `claudeCodeTool` /
`claudeCodeUsageTool` from that flag; dropping it (2.0.0) removed both, and a stored workflow
holding one loads as an unrecognized node — for EVERY typeVersion, since the synthesized type has
none of its own. That is why 2.0.0 is a major. Two comments in the tree claimed the wrappers
"keep existing"; they did not, and the review caught it before release.

## Testing

```bash
npm test                                    # 833 tests, node:test, no framework
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
with the node installed and asserts 63 named behaviours against real executions:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)
npm run e2e:up && npm run e2e:run && npm run e2e:verdict
```

The node must be installed **inside** the container: the SDK ships platform-specific CLI binaries,
so a macOS-host install fetches the darwin build and cannot run on linux. `e2e:run` costs real API
spend — the timeout cases run real agent turns, budget under US$1 for a full pass.

`readUsage.ts` has no unit tests on purpose: it spawns a real CLI, and this suite covers it.

The three authentication cases (case52-54) are the only checks that prove a credential actually
overrides the host login. case53 is the load-bearing one: the container **is** logged in, so a run
that fails to authenticate on a deliberately invalid credential can only have been running on that
credential. A passing case52 alone would not distinguish "the credential worked" from "the
credential was ignored and the host answered".

**A 401 does not fail fast, and how it surfaces depends on the Timeout.** The CLI retries an
`authentication_failed` response with backoff. Measured twice, on the same invalid credential:
with a 300s timeout the run fails at ~184s with a clean
`Failed to authenticate. API Error: 401 API key is invalid.`; with case53's 20s timeout the node's
own timer fires first and the run reports a *timeout* with 0 assistant turns, naming nothing. The
first reading came from case53 alone and was written up as "a 401 never fails fast", which was
generalising from one short-timeout sample — the UI runs corrected it.

That is why `run-cases.mjs` counts `"error":"authentication_failed"` out of the raw log into
`results.json` rather than letting the verdict assert on the error message: the message is only
present on the slow path, and "it timed out" is also what a network fault looks like.

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