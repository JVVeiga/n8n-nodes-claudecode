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

## Common Commands

### Development
- `npm run dev` - Run TypeScript compiler in watch mode for development
- `npm run build` - Build the project (clean dist, compile TypeScript, copy icons)
- `npm run format` - Format code using Prettier
- `npm run lint` - Run ESLint to check code quality
- `npm run lintfix` - Auto-fix linting issues where possible

### n8n Integration
- Install locally: `npm link` then `n8n start` to test the node
- The node appears in n8n UI under "Claude Code" category
- Debug output available when Debug option is enabled in node parameters

## Architecture Overview

This is an n8n community node that integrates Claude Code SDK into n8n workflows. The architecture consists of:

1. **Main Node Implementation** (`nodes/ClaudeCode/ClaudeCode.node.ts`)
   - Implements `INodeType` interface from n8n
   - Provides Query and Continue operations
   - Handles Claude Code SDK initialization and message processing
   - Manages tool availability and project path configuration

2. **Tool System**
   - Dynamic tool enabling/disabling based on user configuration
   - Supports: Bash, Edit/MultiEdit, Read/Write, Web operations, Todo management
   - MCP servers supported via Claude's native configuration system (.claude/settings.local.json)

3. **Output Handling**
   - Multiple output formats: structured JSON, messages array, or plain text
   - Streaming support with abort signal handling
   - Debug mode for troubleshooting

4. **Project Path Support** (v0.2.0+)
   - Configure working directory via `projectPath` parameter
   - Allows Claude Code to run in specific project directories
   - Enables access to code repositories without changing n8n's working directory

## Key Development Patterns

### n8n Node Structure
- All node logic resides in `ClaudeCode.node.ts`
- Parameters defined using n8n's declarative schema
- Error handling follows n8n patterns with `NodeOperationError`
- Supports both single execution and streaming responses

### TypeScript Configuration
- Strict mode enabled for type safety
- Target ES2019 with CommonJS modules (n8n requirement)
- Source maps generated for debugging
- Output to `dist/` directory

### Code Style
- Uses tabs with width 2 (n8n standard)
- Single quotes for strings
- Semicolons required
- Maximum line width: 100 characters
- ESLint configured with n8n-nodes-base rules


## Testing Approach

No automated tests are configured (typical for n8n community nodes). Testing involves:
1. Building the node: `npm run build`
2. Linking locally: `npm link`
3. Starting n8n: `n8n start`
4. Creating test workflows with various parameter combinations
5. Using Debug mode to inspect Claude Code interactions

## Configuration Examples

The `examples/` directory contains sample configurations:
- **simple-project/**: Basic setup without MCP servers
- **project-with-mcp/**: Full MCP server configuration example

Key configuration files:
- `.mcp.json`: Defines available MCP servers (project root)
- `.claude/settings.json`: Team-shared settings
- `.claude/settings.local.json`: Personal settings (gitignored)

When using Project Path, Claude Code automatically loads these configurations from the specified directory.