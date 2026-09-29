# @rehydra/opencode

在主 LLM 请求发出之前，脱敏 OpenCode 消息中检测到的密钥。

[English](./README.en.md)

该插件拦截 [OpenCode](https://github.com/sst/opencode) 与 LLM 之间的对话。你的 `.env` 文件中的密钥在离开本机前被替换为占位符，并在任何工具（shell 命令、文件写入等）在本地执行前透明还原。

它面向 OpenCode 的 **Plugin V2** API（`session.hook` / `tool.hook`）。不支持早期 V1 插件 hook 和单数形式的 `"plugin"` 配置。

检测到的值会在经过插件 hook 的请求中被遮盖。本地工具和助手的主回答会收到还原后的值。参见下文的标题生成限制。

## 安装

```bash
npm install @rehydra/opencode
```

在 `opencode.json` 中启用。V2 以 `{ package, options }` 条目列表的形式配置插件：

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

默认情况下，插件会在 OpenCode 项目目录下发现 `**/.env*`，包括 `packages/api/.env` 和 `apps/web/.env.local` 这类文件。它会跳过 `node_modules`、`.git` 和符号链接。值长度达到 4 个字符及以上的密钥会被检测和脱敏。

`envFiles` 接受精确路径和 glob 模式，即使 OpenCode 从其他位置启动，也会相对项目目录解析。用 `envFiles: [".env"]` 只加载根目录文件，或用 `envFiles: []` 禁用文件加载。文件在插件初始化时加载一次；修改后需要重启 OpenCode。不存在的文件会被忽略。高级的 `anonymizer` 配置保留对自己 `secrets` 设置的控制权，其相对路径同样以项目目录为根，除非设置了 `secrets.envBaseDirectory`。

## 会话标题限制

OpenCode 通过一次独立的 LLM 调用生成会话标题。插件会脱敏该请求——`session.hook("title")` 对标题消息做匿名化，因此真实值不会发送给标题模型——但它**不会**还原标题响应。它的 `http.response` hook 只对 `kind === "primary"` 的响应还原值，`title`、`compaction` 和 `generate` 响应保持不变。因此会话标题可能显示 `<PII type="..." id="..."/>` 之类的占位符，而不是真实值。

建议禁用 OpenCode 的标题 agent 以避免占位符标题：

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

这会关闭自动会话标题。修改配置后需要重启 OpenCode。插件保护的是调用其 hook 的请求；它无法拦截这些 hook 之外的其他模型调用。

## 配置

在 `opencode.json` 条目的 `options` 对象中设置选项：

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

自定义逻辑可以创建 `.opencode/plugins/rehydra.ts` 并用工厂函数构建插件：

```typescript
import { createRehydraPlugin } from "@rehydra/opencode";

export default createRehydraPlugin({
  // 扫描多个 env 文件
  envFiles: [".env", ".env.local", ".env.production"],

  // 始终脱敏这些值，即使它们不在 .env 中
  redactValues: ["sk-live-abc123..."],

  // 视为密钥的最小值长度（默认 4）
  minValueLength: 6,

  // 禁用特定 PII 类型的检测
  disableTypes: ["URL", "IP_ADDRESS"],

  // 脱敏 Git 和 GitHub CLI 输出中的身份信息
  vcsIdentities: true,
});
```

`vcsIdentities` 检测 `gh pr` 和 `gh api` 输出中的登录名，以及 `git log`、`git show`、`git blame` 输出中的作者和提交者姓名。它会在同一次工具输出中脱敏这些身份的所有出现，同时不触碰无关命令中的 npm scope 或其他 `@` 标识符。不在上述结构化字段中的 GitHub 显示名仍需要可选的本地 NER 模型。VCS 身份发现支持直接的 `gh pr`、`gh api`、`git log`、`git show` 和 `git blame` 命令，包括 `git -C` 和 `gh --repo` 之类的全局选项。隐藏在 shell 脚本或别名中的命令需要显式集成或 NER。GitHub 发现会遮盖参与者字段及对这些参与者的提及，同时保留 JSON 键和 npm scope。`disableTypes` 仍然优先于身份检测。

## 检测范围

- `.env` 文件中的环境变量值
- API Key、Token 和凭证（基于模式）
- AWS access key 和 secret key
- JWT、私钥、连接串
- 通过 `redactValues` 传入的任何值

## 工作原理

插件使用 OpenCode 的 V2 session 与 tool hook：

| Hook | 作用 |
|---|---|
| `session.hook("context" / "compaction" / "generate")` | 在请求到达 LLM 前匿名化消息文本、工具参数和已完成的工具输出，并在发生匿名化时注入 rehydra 指令 |
| `session.hook("title")` | 仅匿名化会话标题请求的消息 |
| `tool.hook("execute.before")` | 在本地执行前还原工具参数中的真实值 |
| `tool.hook("execute.after")` | 还原已完成工具结果中的真实值 |
| `session.hook("http.response")` | 在 OpenCode 渲染前还原主回答正文（JSON 和 SSE）中的真实值 |
| `session.hook("experimental.ws.receive")` | 还原承载模型输出的 WebSocket 帧中的真实值 |

检测和还原都在本地进行。主对话在转发给 LLM provider 之前通过 session 请求 hook 脱敏。标题请求也会脱敏，但其响应不会被还原——建议的规避方式见上文的[标题限制](#会话标题限制)。

## 助手文本的还原

模型始终只看到占位符，因此在 OpenCode 展示或复用其输出之前，必须改写回真实值。插件在两个 V2 接口上完成还原：

- `session.hook("http.response")` 改写主回答正文。JSON 响应还原每个字符串叶子；SSE 响应（`text/event-stream`）还原每个完整的 `data:` 帧。该 hook 只处理 `kind === "primary"`，title、compaction 和 generate 响应保持不变，因此标题文本仍可能含占位符（见[标题限制](#会话标题限制)）。
- `session.hook("experimental.ws.receive")` 改写承载模型输出的 WebSocket 帧。

两条路径都是尽力而为：还原失败会被记录日志，原始载荷原样透传，因此畸形流或不可用的 hook 不会破坏响应，也不会中断 OpenCode。

## 日志

插件活动记录到 OpenCode 的日志目录（`~/.local/share/opencode/log/`）。以 `--log-level DEBUG` 运行可获得详细输出。

```
INFO service=rehydra scrubbed={"ENV_VAR_SECRET":2} messageCount=3 scrubbed 2 secret(s) from messages
INFO service=rehydra tool=bash callID=call_abc123 rehydrated PII tags in tool args
```

## Rehydra

该插件属于 [Rehydra](https://github.com/EightDoor/opencode-rehydra-sdk)，一个用于 PII 匿名化与还原的开源 SDK。Rehydra 将基于正则的模式匹配与基于 NER 的检测结合，并通过 fetch 包装器、代理服务或框架插件支持任意 LLM provider。

完整文档见[仓库 README](https://github.com/EightDoor/opencode-rehydra-sdk#readme)。

## License

MIT
