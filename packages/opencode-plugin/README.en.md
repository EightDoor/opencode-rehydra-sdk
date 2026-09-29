# @rehydra/opencode

Scrub detected secrets from OpenCode messages before the main LLM request.

[中文](./README.md)

This plugin intercepts the conversation between [OpenCode](https://github.com/sst/opencode) and the LLM. Secrets from your `.env` files are replaced with placeholders before they leave your machine, and transparently restored before any tool (shell commands, file writes, etc.) executes locally.

It targets OpenCode's **Plugin V2** API (`session.hook` / `tool.hook`). The earlier V1 plugin hooks and the singular `"plugin"` configuration are not supported.

Detected values are masked in requests that pass through the plugin hooks. Local tools and the assistant's primary answer receive the restored values. See the title-generation limitation below.

## Install

```bash
npm install @rehydra/opencode
```

Add it to `opencode.json`. V2 configures plugins as a list of `{ package, options }` entries:

```json
{
  "plugins": [
    {
      "package": "@rehydra/opencode",
      "options": {
        "envFiles": [".env", ".env.local"]
      }
    }
  ]
}
```

By default, the plugin discovers `**/.env*` under the OpenCode project directory, including files such as `packages/api/.env` and `apps/web/.env.local`. It skips `node_modules`, `.git`, and symbolic links. Secrets with values of 4+ characters are detected and scrubbed.

`envFiles` accepts exact paths and glob patterns, resolved against the project directory even when OpenCode starts elsewhere. Use `envFiles: [".env"]` for root-only loading, or `envFiles: []` to disable file loading. Files are loaded once when the plugin initializes; restart OpenCode after changing them. Missing files are ignored. An advanced `anonymizer` configuration keeps control of its own `secrets` settings, with relative paths still rooted at the project directory unless `secrets.envBaseDirectory` is set.

## Session title limitation

OpenCode generates session titles with a separate LLM call. The plugin scrubs that request — `session.hook("title")` anonymizes the title messages, so real values are not sent to the title model — but it does **not** rehydrate the title response. Its `http.response` hook restores values only for `kind === "primary"` responses, leaving `title`, `compaction`, and `generate` responses untouched. As a result, a session title can display placeholders such as `<PII type="..." id="..."/>` instead of the real values.

Recommended: disable OpenCode's title agent to avoid placeholder titles:

```json
{
  "plugins": [
    {
      "package": "@rehydra/opencode",
      "options": { "envFiles": [".env", ".env.local"] }
    }
  ],
  "agent": {
    "title": { "disable": true }
  }
}
```

This turns off automatic session titles. Restart OpenCode after changing the configuration. The plugin protects requests that invoke its hooks; it cannot intercept other model calls made outside those hooks.

## Configuration

Set options in the `options` object of the `opencode.json` entry:

```json
{
  "plugins": [
    {
      "package": "@rehydra/opencode",
      "options": {
        "envFiles": [".env", ".env.local", ".env.production"],
        "redactValues": ["sk-live-abc123..."],
        "minValueLength": 6,
        "disableTypes": ["URL", "IP_ADDRESS"],
        "vcsIdentities": true
      }
    }
  ]
}
```

For custom logic, create `.opencode/plugins/rehydra.ts` and build the plugin with the factory:

```typescript
import { createRehydraPlugin } from "@rehydra/opencode";

export default createRehydraPlugin({
  // Scan multiple env files
  envFiles: [".env", ".env.local", ".env.production"],

  // Always redact these values, even if not in .env
  redactValues: ["sk-live-abc123..."],

  // Minimum value length to consider a secret (default: 4)
  minValueLength: 6,

  // Disable detection of specific PII types
  disableTypes: ["URL", "IP_ADDRESS"],

  // Redact identities in Git and GitHub CLI output
  vcsIdentities: true,
});
```

`vcsIdentities` detects logins in `gh pr` and `gh api` output, plus author and committer names in `git log`, `git show`, and `git blame` output. It redacts every occurrence of those identities in the same tool output without touching npm scopes or other `@` identifiers in unrelated commands. GitHub display names outside these structured fields still require the optional local NER model. VCS identity discovery supports direct `gh pr`, `gh api`, `git log`, `git show`, and `git blame` commands, including global options such as `git -C` and `gh --repo`. Commands hidden inside shell scripts or aliases need explicit integration or NER. GitHub discovery masks participant fields and mentions of those participants; it preserves JSON keys and npm scopes. `disableTypes` still takes precedence over identity detection.

## What gets detected

- Environment variable values from `.env` files
- API keys, tokens, and credentials (pattern-based)
- AWS access keys and secret keys
- JWTs, private keys, connection strings
- Any values passed via `redactValues`

## How it works

The plugin uses OpenCode's V2 session and tool hooks:

| Hook | What it does |
|---|---|
| `session.hook("context" / "compaction" / "generate")` | Anonymizes message text, tool arguments, and completed tool output before the request reaches the LLM, and injects the rehydra instruction once anything was anonymized |
| `session.hook("title")` | Anonymizes the session-title request messages only |
| `tool.hook("execute.before")` | Restores real values in tool arguments before local execution |
| `tool.hook("execute.after")` | Restores real values in completed tool results |
| `session.hook("http.response")` | Restores real values in the primary answer body (JSON and SSE) before OpenCode renders it |
| `session.hook("experimental.ws.receive")` | Restores real values in WebSocket frames carrying model output |

Detection and rehydration run locally. The main conversation is scrubbed through the session request hooks before forwarding to the LLM provider. Session-title requests are scrubbed as well, but their responses are not rehydrated — see the [title limitation](#session-title-limitation) above for the recommended opt-out.

## Recovery of assistant text

The model only ever sees placeholders, so its output has to be rewritten back to the real values before OpenCode shows or reuses it. The plugin restores them on two V2 surfaces:

- `session.hook("http.response")` rewrites the primary answer body. JSON responses have every string leaf restored; SSE responses (`text/event-stream`) have each complete `data:` frame restored. The hook processes `kind === "primary"` only — title, compaction, and generate responses are left untouched, so title text can still contain placeholders (see the [title limitation](#session-title-limitation)).
- `session.hook("experimental.ws.receive")` rewrites WebSocket frames that carry model output.

Both paths are best-effort: a rehydration failure is logged and the original payload is passed through unchanged, so a malformed stream or an unavailable hook never corrupts the response or stops OpenCode.

## Logging

Plugin activity is logged to OpenCode's log directory (`~/.local/share/opencode/log/`). Run with `--log-level DEBUG` for detailed output.

```
INFO service=rehydra scrubbed={"ENV_VAR_SECRET":2} messageCount=3 scrubbed 2 secret(s) from messages
INFO service=rehydra tool=bash callID=call_abc123 rehydrated PII tags in tool args
```

## Rehydra

This plugin is part of [Rehydra](https://github.com/EightDoor/opencode-rehydra-sdk), an open-source SDK for PII anonymization and rehydration. Rehydra combines regex-based pattern matching with NER-based detection and supports any LLM provider via fetch wrappers, proxy servers, or framework plugins.

Full documentation in the [repository README](https://github.com/EightDoor/opencode-rehydra-sdk#readme).

## License

MIT
