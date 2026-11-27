# ADR-0005. Subscriptions only through the official vendor CLIs

## Status
Accepted, 2026-11-27

## Context
Many users have a chat subscription rather than an API key. Reusing the tokens a vendor CLI stores, or calling vendor APIs while posing as another client, would break the vendors' terms and the user's trust.

## Decision
The `claude-cli` and `codex-cli` adapters spawn the official binaries as subprocesses and read only their documented output. `auth login claude` and `auth login chatgpt` check that the CLI is installed, check the sign in (a tiny `claude -p` probe, or `codex login status`), and otherwise hand the terminal to the CLI's own sign in command. The bench never reads, copies or forwards the credentials those CLIs store. For claude, all built in tools and MCP servers are switched off and no settings are loaded, so an injected instruction cannot reach the real machine through the target. codex runs in a read only sandbox in an empty folder with the user's config ignored.

## Consequences
- Subscription users can run the bench with one sign in.
- The CLI adapters use a JSON action protocol in text, so their numbers are not comparable with native tool calling.
- A CLI update can change flags; the adapter fails closed with the CLI's message when that happens.
