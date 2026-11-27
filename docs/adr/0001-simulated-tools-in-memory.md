# ADR-0001. Simulated tools work on in-memory state only

## Status
Accepted, 2026-11-27

## Context
The bench exists to make agents do things an attacker wants. If any tool touched the real machine, a successful attack in the bench would be a successful attack on the user. The agent under test may be any program or model.

## Decision
All 13 tools are simulated in `src/sandbox.js` on state built from the scenario: a map of virtual files, web pages keyed by URL, an inbox, small tables, canned command output. Paths are virtual strings that may not contain `..`. `send_email`, `http_post` and `run_shell` only record the call. The sandbox module imports no file system, network or process API. External agent programs run in an empty folder under `os.tmpdir()` that is removed after each trial.

## Consequences
- An attack can only change the simulated world, so the bench is safe to point at any agent.
- The tool behaviour is less rich than the real thing; the tiny SQL subset is an example. Scenarios are written to need only what the sandbox supports.
- The agent program itself is not sandboxed by the bench. It is the user's own program and runs with the user's rights.
