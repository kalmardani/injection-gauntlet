# ADR-0003. External agents speak line delimited JSON, one call at a time

## Status
Accepted, 2026-11-27

## Context
Agents are written in many languages. The bench must test them without an SDK and without the agent having to change much.

## Decision
The command target spawns the agent and exchanges one JSON object per line over stdin and stdout (`start`, `user`, `tool_result`, `end` in; `tool_call`, `final`, `error`, `log` out). The agent sends one tool call and waits for its result. The http target is the stateless twin: every step is one POST with the whole transcript. Both are specified in `docs/protocol.md` and versioned as `injection-gauntlet/agent@1`.

## Consequences
- Any language with JSON and standard streams can be tested, with a few dozen lines of glue.
- Parallel tool calls must be serialised by the agent's adapter.
- A protocol violation ends the trial as an error (fail closed), so a broken adapter cannot look like a safe agent, since the trial is not passed.
