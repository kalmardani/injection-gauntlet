# External agent protocol, `injection-gauntlet/agent@1`

Two ways to put your own agent under test. Your agent keeps its own model, prompt and loop. The bench only supplies the user turns and answers its tool calls with simulated results.

## Command target

```
injection-gauntlet run -- node my-agent.js
injection-gauntlet run -- python3 my_agent.py --some-flag
```

The bench starts the command once per trial, in an empty temporary folder, with `shell: false`. Relative file arguments that exist on disk are turned into absolute paths before the start, because the working folder is the temp folder. Messages are JSON objects, one per line, UTF-8. CRLF line endings are accepted. Lines longer than 1 MiB end the trial.

### Bench to agent (stdin)

```json
{"type":"start","protocol":"injection-gauntlet/agent@1","scenario":"email-newsletter-bcc","trial":0,"seed":123,"tools":[{"name":"send_email","description":"...","parameters":{"type":"object"}}],"context":"You work for ...","system":null}
{"type":"user","turn":0,"content":"Reply to the meeting request from Priya ..."}
{"type":"tool_result","id":"c1","name":"list_emails","content":"[...]","is_error":false}
{"type":"end"}
```

- `tools` uses JSON Schema for `parameters`, ready to pass to most tool calling APIs.
- `context` is scenario context such as who the user is. Add it to your system prompt or first message.
- `system` is a system prompt, set only when the user passed `--system-prompt-file`. Otherwise use your own.
- After `end`, exit within two seconds or the process is killed.

### Agent to bench (stdout)

```json
{"type":"tool_call","id":"c1","name":"list_emails","arguments":{}}
{"type":"final","content":"I replied to Priya."}
{"type":"error","message":"model unavailable"}
{"type":"log","message":"anything, ignored"}
```

- After each `user` message, send any number of `tool_call` messages, each followed by waiting for its `tool_result`, then one `final`.
- Send one tool call at a time. If your model returns several, send them one after another.
- `id` is optional; the bench makes one up when it is missing.
- `error` ends the trial as an error. Anything that is not valid JSON does the same. Write debug output to stderr or as `log` messages.

### Limits

Per agent reply 120 s by default (`--timeout`), per turn 10 tool calls (`--max-steps`), per trial 30 tool calls (`--max-tool-calls`) and 600 s (`--trial-timeout`). The same call with the same arguments more than three times in a row ends the trial, and so do three invalid calls in a row.

### Minimal Python agent

```python
import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    msg = json.loads(line)
    if msg["type"] == "end":
        break
    if msg["type"] == "user":
        # Call your model here. This stub answers without tools.
        send({"type": "final", "content": "Hello from Python."})
```

## HTTP target

```
injection-gauntlet run --target http --url http://127.0.0.1:8787/step
```

Stateless. For every step the bench POSTs the whole session and expects one reply object, the same `tool_call`, `final` or `error` shapes as above.

```json
{
  "protocol": "injection-gauntlet/agent@1",
  "session": "email-newsletter-bcc:0:123",
  "scenario": "email-newsletter-bcc",
  "trial": 0,
  "seed": 123,
  "system": null,
  "context": "You work for ...",
  "tools": [ ... ],
  "messages": [
    {"role": "user", "content": "Reply to ..."},
    {"role": "assistant", "tool_call": {"id": "c1", "name": "list_emails", "arguments": {}}},
    {"role": "tool", "id": "c1", "name": "list_emails", "content": "[...]", "is_error": false}
  ]
}
```

Set `IG_HTTP_TOKEN` to send `Authorization: Bearer <token>`. Requests time out after `--timeout` and are retried twice on 429, 5xx and network errors, so a step handler should be safe to call twice with the same body.

`examples/agents/http-agent.js` is a working endpoint.
