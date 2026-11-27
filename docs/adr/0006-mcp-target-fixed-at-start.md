# ADR-0006. The MCP server cannot choose what it runs

## Status
Accepted, 2026-11-27

## Context
The MCP server is driven by a model. If a tool call could name the agent command, the endpoint URL or a file path, a prompt injection against that model could make the bench run an arbitrary program or read arbitrary files.

## Decision
The target (provider, command or URL) and the scenario folders are fixed by the user's flags or config when `injection-gauntlet mcp` starts. Tool calls can pick scenario ids, categories, k (at most 5) and a seed. Reports are addressed by session ids such as `r1`, not by path. Tool arguments are validated against closed schemas, so extra fields such as `command` are rejected.

## Consequences
- Switching targets means restarting the server with other options.
- Reports from earlier sessions are read with the CLI, not through MCP.
