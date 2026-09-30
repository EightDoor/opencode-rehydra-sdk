# rehydra-pi

在主 LLM 请求发出之前，脱敏 Pi 对话中检测到的密钥。

[English](./README.en.md)

这个扩展拦截 [Pi](https://pi.dev) 与 LLM 之间的对话。你的 `.env` 文件中的密钥在离开本机前被替换为占位符，并在工具（shell 命令、文件写入等）在本地执行前透明还原。

它依赖 Pi 的 `ExtensionAPI`：`context_with_system`、`tool_call`、`tool_result`、`message_end`、`session_start` / `session_shutdown`。

脱敏和还原都在本地进行；模型只用占位符推理，工具始终拿到真实值。

## 安装

```bash
pi install npm:rehydra-pi
```

Pi 会在 `~/.pi/agent/settings.json` 写入包声明。然后编辑该文件添加扩展配置：

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

`rehydra` 键的所有字段对应 [`opencode-rehydra-core`](https://www.npmjs.com/package/opencode-rehydra-core) 的同名选项，详见仓库 README。`envFiles` 默认是 `["**/.env*"]`，会跳过 `node_modules`、`.git` 和符号链接。

## 工作原理

| 钩子 | 作用 |
|---|---|
| `session_start` | 实例化匿名器、装配会话映射、解析 `rehydra` 配置 |
| `context_with_system` | 匿名化模型请求前的所有消息，并按需追加 rehydra 指令 |
| `tool_call` | 在工具执行前还原工具入参中的 PII 标签 |
| `tool_result` | 在结果返回给模型前脱敏真实 PII |
| `message_end` | 改写最终回答的文本块，把 PII 标签还原为真实值 |
| `session_shutdown` | 释放匿名器与会话注册表 |

## 限制

- 不会拦截用户在 UI 里粘贴的、且未走这些 hook 的模型调用。
- 默认禁用 `URL` 和 `IP_ADDRESS`；通过 `disableTypes: []` 重新启用。
- Pi 扩展无法保证消息标题（title）与元数据走相同的 hook，因此这些字段仍可能包含占位符。建议在脱敏时启用完整的 PII 脱敏策略。

## License

MIT