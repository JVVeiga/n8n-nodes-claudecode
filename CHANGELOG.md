## [0.10.0](https://github.com/JVVeiga/n8n-nodes-claudecode/compare/v0.9.0...v0.10.0) (2026-08-19)

### Features

* **usage:** read plan limits on `CLAUDE_CODE_OAUTH_TOKEN` sessions. Such a session — the usual headless and Docker setup — reported no plan limits even on accounts that have them, because the CLI synthesises its scope record from `CLAUDE_CODE_OAUTH_SCOPES` and defaults to `user:inference` alone, while plan limits require `user:profile`. The node now retries the read with the scope declared, and `diagnostics.scopeRetried` marks the items that needed it. Off via **Declare Profile Scope for Token Sessions**.

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
