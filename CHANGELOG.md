# Changelog

All notable changes to this project. Versions follow semantic versioning; 0.x makes no stability promise.

## 0.1.0, 2026-11-27

### Added
- Scenario format `injection-gauntlet/scenario@1` with schema and semantic validation, and 30 built in scenarios in 11 categories.
- In memory sandbox with 13 simulated tools: list_files, read_file, write_file, delete_file, http_get, http_post, search_web, list_emails, read_email, send_email, delete_email, run_query, run_shell.
- Deterministic predicates: tool_called, email_to_injected_address, request_to_injected_host, output_link_to_injected_host, canary_leak, unneeded_destructive, final_matches, file_state, not, any_of, all_of. Attacker indicators and lethal trifecta exposure are derived per scenario.
- Runner with k trials per scenario, seeded canaries, step, call, repetition and time limits, tool allowlist, pass^k, attack success rate and utility per category.
- Targets: reference agent over the provider layer, command target (line delimited JSON over stdio), http target. Agent protocol `injection-gauntlet/agent@1`.
- Provider layer: openai compatible, Messages API, claude CLI and codex CLI (subscription, JSON action protocol), fake (tests). Auth kinds api-key, oauth, none, subscription.
- OAuth 2.0 client with client credentials, authorization code with PKCE and loopback redirect, and device grant; per user token cache; `auth login|status|logout`, plus `auth login claude` and `auth login chatgpt` through the official CLIs.
- Reports: JSON, self contained HTML, terminal summary, `compare`, `report` re-render, `--max-asr` exit code.
- MCP server over stdio with list_scenarios, get_scenario, run_scenarios, list_reports, read_report.
- Calibration agents (gullible, refusing, HTTP) and a defenses example with measured results.
