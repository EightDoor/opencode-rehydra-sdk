# pi-rehydra

Scrub detected secrets from Pi conversations before the main LLM request.

[中文](./README.md)

This extension intercepts the conversation between [Pi](https://pi.dev) and the LLM. Secrets from your `.env` files are replaced with placeholders before they leave your machine, and transparently restored before any tool (shell commands, file writes, etc.) executes locally; a placeholder that cannot be restored blocks that tool call.

It uses Pi's `ExtensionAPI` events: `context_with_system`, `tool_call`, `tool_result`, `message_end`, and `session_start` / `session_shutdown`.

Detection and rehydration are local. The model only sees placeholders; your tools always see real values.

## Install

```bash
pi install npm:pi-rehydra
```

Pi writes the package entry to `~/.pi/agent/settings.json`. Edit that file to add extension options:

```json
{
  "packages": [
    {
      "source": "npm:pi-rehydra"
    }
  ],
  "rehydra": {
    "envFiles": [".env", ".env.local"],
    "redactValues": ["sk-live-abc123..."],
    "allowLiteralTagsIn": ["write", "edit"]
  }
}
```

Every key under `rehydra` is an extension option: `envFiles`, `redactValues`, `minValueLength`, `disableTypes`, `locale`, `vcsIdentities`, `policy`, `anonymizer`, `tagFormat`. `envFiles` defaults to `["**/.env*"]`, skipping `node_modules`, `.git`, and symlinks.

`allowLiteralTagsIn` defaults to an empty array (always block). Tools listed here — typically `write` and `edit` — keep an **unresolvable** literal tag in their arguments instead of aborting, so you can write documentation or tests that intentionally show tag examples. Every allowed occurrence is logged (`allowed literal tag in tool args`, tool name and argument path only). Resolvable tags are still restored in every tool.

## How it works

| Event | Effect |
|---|---|
| `session_start` | Instantiate the anonymizer, build the session map, parse the `rehydra` config |
| `context_with_system` | Anonymize all request messages and inject the rehydra instruction when needed |
| `tool_call` | Strictly restore PII tags in tool arguments before local execution; an unresolvable tag blocks the call |
| `tool_result` | Anonymize the completed tool result before it re-enters model context |
| `message_end` | Rewrite the final assistant message so PII tags are replaced with real values |
| `session_shutdown` | Dispose of the anonymizer and session registry |

## Limitations
- Tool-argument rehydration is strict: when a tag is absent from this session's map (or the map is missing, or decryption fails), the tool call is blocked rather than run with `<PII .../>` as a real value. A placeholder can only be restored from the same session's map; the default map is in memory, so tags from before a process restart cannot be restored.

- Model calls that bypass these hooks (rare, e.g. user-initiated notes) are not intercepted.
- `URL` and `IP_ADDRESS` are disabled by default; re-enable with `disableTypes: []`.
- This extension cannot guarantee that title or compaction summaries stay sanitized — disable title agents if you need titles to be human-readable.

## License

MIT