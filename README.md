# 🚀 Claude Code for n8n

> **This is a fork** of [@johnlindquist/n8n-nodes-claudecode](https://github.com/johnlindquist/n8n-nodes-claudecode), which is itself a fork of [holt-web-ai/n8n-nodes-claudecode](https://github.com/holt-web-ai/n8n-nodes-claudecode). All credit for the original node goes to them.
>
> It is published separately because it migrates to the Claude Agent SDK for Claude Code v2 and adds effort, thinking, Ultracode, tool restriction, a spend cap and run diagnostics. See [What this fork changes](#-what-this-fork-changes).

**Bring the power of Claude Code directly into your n8n automation workflows!**

Imagine having an AI coding assistant that can analyze your codebase, fix bugs, write new features, manage databases, interact with APIs, and automate your entire development workflow - all within n8n. That's exactly what this node enables.

[![n8n](https://img.shields.io/badge/n8n-community_node-orange.svg)](https://n8n.io/)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Powered-blue.svg)](https://claude.ai/code)
[![npm](https://img.shields.io/npm/v/@joaoveiga/n8n-nodes-claudecode.svg)](https://www.npmjs.com/package/@joaoveiga/n8n-nodes-claudecode)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE.md)

## 🔀 What this fork changes

Everything below this section is the upstream node's documentation. This fork adds:

- **Claude Code v2 support** — migrated from `@anthropic-ai/claude-code` (CLI-only since v2, so the original node no longer resolves) to `@anthropic-ai/claude-agent-sdk`. Requires Node 22+.
- **Model, Effort and Thinking selectors** — Opus 5 / Sonnet 5 / Haiku 4.5 / Fable 5, effort from low to max, plus Ultracode (xHigh + the Workflow tool).
- **Restrict Built-in Tools** — the control that actually bounds the tool set. Upstream's Allowed Tools maps to the SDK's auto-approve list and cannot restrict anything.
- **Max Budget (USD)** — a hard spend cap. Max Turns and Timeout bound length, not cost.
- **Diagnostics** — every run reports the resolved model, the effort actually applied, the models billed, the session id and whether Ultracode orchestration was available.
- **Cancellation and failure handling** — stopping the n8n execution now stops the agent; failed runs report their real cost instead of `$0`; Text output no longer swallows errors into a green execution.
- **Session ID** on Continue, so concurrent executions stop sharing one conversation.

## 🌟 What Can You Build?

### 🔧 **Automated Code Reviews**
Create workflows that automatically review pull requests, suggest improvements, and even fix issues before merging.

### 🐛 **Intelligent Bug Fixing**
Connect error monitoring tools to Claude Code - automatically diagnose and fix production issues in real-time.

### 📊 **Database Management**
Let Claude Code write complex SQL queries, optimize database schemas, and generate migration scripts based on your requirements.

### 🤖 **Self-Improving Workflows**
Build n8n workflows that can modify and improve themselves using Claude Code's capabilities.

### 📝 **Documentation Generation**
Automatically generate and update documentation for your entire codebase, APIs, or databases.

### 🔄 **Code Migration**
Automate the migration of legacy codebases to modern frameworks with intelligent refactoring.

### 🎫 **Customer Support Automation**
Transform support tickets into code fixes automatically:
- Analyze customer bug reports and reproduce issues
- Generate fixes for reported problems
- Create test cases to prevent regression
- Update documentation based on common questions
- Auto-respond with workarounds while fixes are deployed

## ⚡ Quick Start

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

## 🎯 Real-World Use Cases

### 1. **GitHub Issue to Code**
```
Webhook (GitHub Issue) → Claude Code → Create PR → Notify Slack
```
Automatically implement features or fix bugs when issues are created.

### 2. **Database Query Builder**
```
Form Trigger → Claude Code → Execute Query → Send Results
```
Natural language to SQL - let non-technical users query databases safely.

### 3. **Code Quality Guardian**
```
Git Push → Claude Code → Analyze Code → Block/Approve → Notify
```
Enforce coding standards and catch issues before they reach production.

### 4. **API Integration Builder**
```
HTTP Request → Claude Code → Generate Integration → Test → Deploy
```
Automatically create integrations with third-party APIs.

### 5. **Intelligent Log Analysis**
```
Error Logs → Claude Code → Diagnose → Create Fix → Open PR
```
Turn error logs into actionable fixes automatically.

### 6. **Customer Support to Code Fix**
```
Support Ticket → Claude Code → Reproduce Issue → Generate Fix → Test → Deploy → Auto-Reply
```
Transform customer complaints into deployed fixes in minutes, not days.

## 🛠️ Powerful Features

### **Project Context Awareness**
Set a project path and Claude Code understands your entire codebase context:
- Analyzes existing code patterns
- Follows your coding standards
- Understands your architecture
- Respects your dependencies

### **Tool Arsenal**
Claude Code comes equipped with powerful tools:
- 📁 **File Operations**: Read, write, edit multiple files
- 💻 **Bash Commands**: Execute any command
- 🔍 **Smart Search**: Find patterns across your codebase
- 🌐 **Web Access**: Fetch documentation and resources
- 📊 **Database Access**: Via MCP servers
- 🔗 **API Integration**: GitHub, Slack, and more via MCP

### **Advanced SDK Options**
Fine-tune Claude Code's behavior with these powerful options:
- 🚫 **Disallowed Tools**: Explicitly block specific tools for security
- 🔄 **Fallback Model**: Automatically switch models when primary is overloaded
- 🧠 **Max Thinking Tokens**: Control Claude's internal reasoning depth
- 🔐 **Permission Modes**: Choose from `default`, `acceptEdits`, `bypassPermissions`, or `plan`
- ⏱️ **Timeout Wrap-Up Grace**: Stop a run that overruns *and still get its tokens, cost and a
  handover summary — see [Timeouts](#-timeouts)

### **Model Context Protocol (MCP)**
Extend Claude Code with specialized capabilities:
- PostgreSQL/MySQL database access
- GitHub repository management
- Slack workspace integration
- Custom tool development

## ⏱️ Timeouts

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

### Node version 1 vs 1.1

The grace changes when a run stops, so it is gated behind the node version rather than switched on
by a package upgrade:

| | Version 1 (existing nodes) | Version 1.1 (new nodes) |
|---|---|---|
| Timeout Wrap-Up Grace default | `0` — process killed at the Timeout, as before | `60` |
| Failure item shape | flat report at the top level | `{ error, message, details }` |
| Failure items on the error output | stay on the main output | routed to the error output |

Existing nodes keep behaving exactly as they did. To opt in, either set the grace explicitly or add
a fresh Claude Code node. Both versions get the diagnostics, the session ID and the self-describing
error message.

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

With **On Error** left at its default the execution still fails, as it should — the same data is on
the error's `context`, and the message and description are shown in the execution panel. An **Error
Workflow** only ever receives `execution.error.message`, which is why that message carries the turns,
cost and session ID inline.

## 📋 Configuration Examples

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

## 🔄 Workflow Patterns

### Pattern 1: Continuous Code Improvement
```
Schedule Trigger (Daily)
  ↓
Claude Code (Analyze codebase for improvements)
  ↓
Create GitHub Issues
  ↓
Assign to Team
```

### Pattern 2: Natural Language to Code
```
Slack Command
  ↓
Claude Code (Generate code from description)
  ↓
Create Pull Request
  ↓
Run Tests
  ↓
Notify Results
```

### Pattern 3: Intelligent Monitoring
```
Error Webhook
  ↓
Claude Code (Diagnose issue)
  ↓
If (Can fix automatically)
  ├─ Yes: Create Fix PR
  └─ No: Create Detailed Issue
```

## 🚦 Getting Started

### 1. **Verify Prerequisites**
Make sure Claude Code CLI is installed and authenticated on your n8n server:
```bash
claude --version  # Should show the version
```

If not installed, see the [Quick Start](#-quick-start) section above.

### 2. **Create Your First Workflow**
1. In n8n, create a new workflow
2. Add a **Manual Trigger** node (for testing)
3. Add the **Claude Code** node
4. Configure:
   - **Operation**: Query
   - **Prompt**: "Analyze the code in this directory and suggest improvements"
   - **Project Path**: `/path/to/your/project`
   - **Model**: Sonnet (faster) or Opus (more powerful)
5. Click **Execute Workflow**
6. Watch Claude Code analyze your project!

### 3. **Explore Advanced Features**
- Check out the [workflow templates](./workflow-templates/) for ready-to-use examples
- See the [examples directory](./examples/) for configuration options
- Read about [MCP servers](#model-context-protocol-mcp) for database and API access

## 💡 Pro Tips

### 🎯 **Use Project Paths**
Always set a project path for better context and results:
```
/home/user/projects/my-app
```

### 🔒 **Configure Permissions**
Control what Claude Code can do in `.claude/settings.json`:
```json
{
  "permissions": {
    "allow": ["Read(*)", "Write(*)", "Bash(npm test)"],
    "deny": ["Bash(rm -rf *)"]
  }
}
```

### 🔗 **Chain Operations**
Use "Continue" operation to build complex multi-step workflows while maintaining context.

### 📊 **Output Formats**
- **Structured**: Full details with metrics
- **Messages**: For debugging
- **Text**: Simple results for chaining

## 🤝 Community & Support

- 📖 [Documentation](https://github.com/JVVeiga/n8n-nodes-claudecode)
- 🐛 [Report Issues](https://github.com/JVVeiga/n8n-nodes-claudecode/issues) — for this fork. Please do not open issues about it on the upstream repositories.
- 🌟 [Star on GitHub](https://github.com/JVVeiga/n8n-nodes-claudecode)
- ⬆️ [Upstream project](https://github.com/johnlindquist/n8n-nodes-claudecode) by John Lindquist

## 📈 What's Next?

We're constantly improving! Upcoming features:
- Visual workflow builder for Claude Code operations
- Pre-built workflow templates
- Enhanced debugging tools
- More MCP server integrations

## 🔄 Development & Contributing

### Commit Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` New features (minor version bump)
- `fix:` Bug fixes (patch version bump)
- `docs:` Documentation changes
- `chore:` Maintenance tasks
- `test:` Adding or updating tests

Use `npm run commit` for an interactive commit message builder.

### Release Process

Releases are published manually. There is no CI — validate locally first:

```bash
npm run lint
npm run build
npm publish --dry-run        # check the file list and version
```

Then bump the version and publish. npm requires a 2FA code:

```bash
npm version patch            # or minor / major
npm publish --otp=123456
git push && git push --tags
```

`npm version` writes `package.json` and creates the matching git tag.

## 📄 License

MIT - Build amazing things!

---

**Ready to revolutionize your development workflow?** Install Claude Code for n8n today and join the future of automated software development!

### Lineage

1. Originally created by [Adam Holt](https://github.com/holt-web-ai) — [holt-web-ai/n8n-nodes-claudecode](https://github.com/holt-web-ai/n8n-nodes-claudecode)
2. Forked and maintained by [John Lindquist](https://github.com/johnlindquist) — [johnlindquist/n8n-nodes-claudecode](https://github.com/johnlindquist/n8n-nodes-claudecode)
3. This fork, maintained by [João Veiga](https://github.com/JVVeiga) — [JVVeiga/n8n-nodes-claudecode](https://github.com/JVVeiga/n8n-nodes-claudecode)

MIT throughout. The original copyright notice is kept intact in [LICENSE.md](LICENSE.md).