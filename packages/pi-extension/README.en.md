# rehydra-pi

Scrub detected secrets from Pi conversations before the main LLM request.

[中文](./README.md)

This extension intercepts the conversation between [Pi](https://pi.dev) and the LLM. Secrets from your `.env` files are replaced with placeholders before they leave your machine, and transparently restored before any tool (shell commands, file writes, etc.) executes locally.

It uses Pi's `ExtensionAPI` events: `context_with_system`, `tool_call`, `tool_result`, `message_end`, and `session_start` / `session_shutdown`.

Detection and rehydration are local. The model only sees placeholders; your tools always see real values.

## Install

```bash
pi install npm:rehydra-pi
```

Pi writes the package entry to `~/.pi/agent/settings.json`. Edit that file to add extension options:

```json
{
  "packages": [
    {
      "source": "npm:rehydra-pi"
    }
  ],
  "rehydra": {
    "envFiles": [".env", ".env.local"],
    "redactValues": ["sk-live-abc123..."]
  }
}
```

Every key under `rehydra` maps to the same-named option on [`opencode-rehydra-core`](https://www.npmjs.com/package/opencode-rehydra-core). `envFiles` defaults to `["**/.env*"]`, skipping `node_modules`, `.git`, and symlinks.

## How it works

| Event | Effect |
|---|---|
| `session_start` | Instantiate the anonymizer, build the session map, parse the `rehydra` config |
| `context_with_system` | Anonymize all request messages and inject the rehydra instruction when needed |
| `tool_call` | Restore PII tags in tool arguments before local execution |
| `tool_result` | Anonymize the completed tool result before it re-enters model context |
| `message_end` | Rewrite the final assistant message so PII tags are replaced with real values |
| `session_shutdown` | Dispose of the anonymizer and session registry |

## Limitations

- Model calls that bypass these hooks (rare, e.g. user-initiated notes) are not intercepted.
- `URL` and `IP_ADDRESS` are disabled by default; re-enable with `disableTypes: []`.
- This extension cannot guarantee that title or compaction summaries stay sanitized — disable title agents if you need titles to be human-readable.

## License

MIT