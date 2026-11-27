# Contributing

- Node.js 22.5 or newer, no dependencies, standard library only.
- `npm test` must pass on Windows, macOS and Linux. Tests never use the network; use the fake provider, the fake CLIs in `test/helpers/` and loopback servers.
- New scenarios: one JSON file in `scenarios/`, named after its id, validated with `node bin/injection-gauntlet.js validate`. Write the payload yourself, keep it a benign simulation aimed at the fake tools, and use reserved `.example` domains for every attacker address.
- Prefer predicates on tool calls and files over answer text. If you check answer text, add a test that a refusal quoting the payload still passes.
- Run the calibration. The gullible example agent must still be hijacked in most categories.
- House style for docs, comments and messages: plain sentences, no em or en dash characters, colons used sparingly, no emoji. `test/repo.test.js` checks the dashes.
