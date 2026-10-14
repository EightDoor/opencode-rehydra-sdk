/**
 * Pi 扩展的 VCS 身份保护测试：
 * - 识别器单元测试（GitHub 登录名 / git 作者）；
 * - 扩展端到端：vcsIdentities 开关决定 git/gh 工具结果是否被脱敏，
 *   以及 tool_call 是否把占位符还原为原值。
 */
import { afterEach, describe, expect, it } from "vitest";

import { createRehydraPiExtension } from "../../src/pi-extension/extension.js";
import { githubUsernameRecognizer } from "../../src/pi-extension/github-username.js";
import { gitIdentityRecognizer } from "../../src/pi-extension/git-identity.js";
import { createMockPiContext, eventHandler } from "./pi-test-helpers.js";
import type { ContextWithSystemEvent } from "../../src/pi-extension/host-types.js";

const GIT_OUTPUT = [
  "Author: Alice Developer <alice@example.com> 1720000000 +0000",
  "author: alice-dev",
].join("\n");

describe("VCS identity recognizers", () => {
  it("does not replace JSON keys or npm scopes that equal a known login", () => {
    const text = '{"id":1,"login":"id"}\n@id asked about @id/package';
    const spans = githubUsernameRecognizer.find(text);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["id", "id"]);
    expect(spans[0]!.start).toBe(text.indexOf('"id"', 10) + 1);
    expect(spans[1]!.start).toBe(text.indexOf("@id") + 1);
  });

  it("extracts names from raw git headers without swallowing email or timestamp", () => {
    const text =
      "author Zoë Example <zoe@example.com> 1720000000 +0000\n" +
      "committer Other Name <other@example.com> 1720000000 +0000";
    expect(gitIdentityRecognizer.find(text).map((s) => s.text)).toEqual([
      "Zoë Example",
      "Other Name",
    ]);
  });
});

describe("Pi extension vcsIdentities", () => {
  let mock: ReturnType<typeof createMockPiContext>;

  afterEach(async () => {
    const shutdown = mock.handlers.find((h) => h.name === "session_shutdown");
    if (shutdown !== undefined) {
      await shutdown.handler({}, mock.ctx);
    }
  });

  async function scrubGitOutput(
    vcsIdentities: boolean,
  ): Promise<{ scrubbed: string; messages: Array<{ content: unknown }> }> {
    mock = createMockPiContext({ vcsIdentities });
    createRehydraPiExtension(mock.api);
    const start = eventHandler(mock, "session_start");
    await start({}, mock.ctx);

    const messages = [
      { role: "user", content: "run git log", timestamp: 0 },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", arguments: { command: "git log" } },
        ],
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        content: [{ type: "text", text: GIT_OUTPUT }],
        timestamp: 0,
      },
    ];

    const ctxHandler = eventHandler(mock, "context_with_system");
    await ctxHandler(
      { type: "context_with_system", messages } as unknown as ContextWithSystemEvent,
      mock.ctx,
    );

    const toolResult = messages[2] as { content: { type?: string; text?: unknown }[] };
    const firstText = toolResult.content[0];
    return {
      scrubbed: typeof firstText?.text === "string" ? firstText.text : "",
      messages,
    };
  }

  it("scrubs git and gh identities when vcsIdentities is enabled", async () => {
    const { scrubbed, messages } = await scrubGitOutput(true);
    expect(scrubbed).toContain("<PII");
    expect(scrubbed).not.toContain("Alice Developer");
    expect(scrubbed).not.toContain("alice-dev");
    // EMAIL 识别器独立于 vcs 开关，始终生效
    expect(scrubbed).not.toContain("alice@example.com");
    // 回写保持 Pi 原始结构：assistant 仍是 toolCall 块，toolResult 仍是 text 块
    const assistantBlocks = messages[1].content as {
      type?: string;
      arguments?: { command?: string };
    }[];
    expect(assistantBlocks[0]?.type).toBe("toolCall");
    expect(assistantBlocks[0]?.arguments?.command).toBe("git log");
    const resultBlocks = messages[2].content as { type?: string; text?: string }[];
    expect(resultBlocks[0]?.type).toBe("text");
    expect(resultBlocks[0]?.text).toBe(scrubbed);
  });

  it("keeps git/gh identities when vcsIdentities is disabled", async () => {
    const { scrubbed } = await scrubGitOutput(false);
    expect(scrubbed).toContain("Alice Developer");
    expect(scrubbed).toContain("alice-dev");
    expect(scrubbed).not.toContain("alice@example.com");
  });

  it("restores scrubbed identities in tool_call arguments", async () => {
    const { scrubbed } = await scrubGitOutput(true);

    const toolHandler = eventHandler(mock, "tool_call");
    const event = {
      type: "tool_call",
      toolCallId: "call-2",
      toolName: "bash",
      input: { command: `git show <<'EOF'\n${scrubbed}\nEOF` },
    };
    await toolHandler(event, mock.ctx);

    const input = event.input as { command: string };
    expect(input.command).toContain("Alice Developer");
    expect(input.command).not.toContain("<PII");
  });
});
