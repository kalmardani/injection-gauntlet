# Security

## Reporting a problem

Please report security problems privately through the repository's GitHub security advisory form (Security, Report a vulnerability) rather than in a public issue. Include the version, the command you ran and what happened. You will get an answer within a week.

## What the tool does on purpose

injection-gauntlet feeds hostile text to an agent and records what the agent tries to do. All tools the agent can call are simulated in memory. Nothing an agent does through them reaches the real file system, network, mailbox or shell. Payloads in the built in scenarios point at reserved `.example` domains.

## Threat model summary

| Boundary | Main risk | Control |
|---|---|---|
| External agent program | it is your own program and runs with your rights | runs in an empty temp folder; the command comes only from your flags or config |
| Agent replies and model output | malformed or hostile data | schema validation, size limits, fail closed, never executed |
| Reports | injected payloads in traces | HTML escaped, control characters stripped, CSP `default-src 'none'`, no scripts |
| Terminal | ANSI escape sequences in agent output | stripped before printing |
| API keys and OAuth tokens | leaking into logs or reports | only in request headers; never printed; token cache file mode 0600 where supported |
| OAuth endpoints | downgrade, code interception | https required except loopback, PKCE S256, state check, loopback redirect on 127.0.0.1 |
| Vendor CLIs (claude, codex) | the target model reaching the real machine | both run in a fresh empty temp folder; claude runs with no built in tools, no MCP servers and no settings; codex runs read only with the user config ignored |
| MCP server | a model choosing what to run | the target is fixed at start; tool arguments cannot carry commands, URLs or paths |

The bench never reads or reuses the credentials stored by the claude or codex CLIs.

Both CLIs run from an empty temporary folder, so the project instruction files of the folder you work in (CLAUDE.md, AGENTS.md and similar) are not sent to the model, while the user level settings of each CLI still load as far as `--setting-sources ''` for claude and `--ignore-user-config` for codex leave them in place.

## Known limits

The codex CLI keeps its own shell tool in read only mode. The prompt tells it not to use it, which is a request, not a control. Prefer the claude CLI or an API adapter when that matters.
