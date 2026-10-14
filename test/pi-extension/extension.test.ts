/**
 * Rehydra Pi 扩展测试。
 *
 * 使用最小化的 mock ExtensionAPI 直接调用事件 handler：
 * - 注册阶段：所有钩子都注册成功；
 * - 运行阶段：scrub / rehydrate 在 Pi 事件中正确工作；
 * - 资源阶段：session_shutdown 幂等释放匿名器。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRehydraPiExtension } from "../../src/pi-extension/extension.js";
import {
  createMockPiContext,
  eventHandler,
} from "./pi-test-helpers.js";

import type {
  ContextWithSystemEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "../../src/pi-extension/host-types.js";

const TEST_SECRET = "sk-proj-piext-abc123xyz789";

describe("Rehydra Pi extension", () => {
  let mock: ReturnType<typeof createMockPiContext>;

  beforeEach(() => {
    mock = createMockPiContext({ redactValues: [TEST_SECRET] });
    createRehydraPiExtension(mock.api);
  });

  afterEach(async () => {
    const handler = mock.handlers.find((h) => h.name === "session_shutdown");
    if (handler !== undefined) {
      await handler.handler({}, mock.ctx);
    }
  });

  it("registers every required hook", () => {
    const names = mock.handlers.map((h) => h.name).sort();
    expect(names).toEqual(
      [
        "context_with_system",
        "message_end",
        "session_shutdown",
        "session_start",
        "tool_call",
        "tool_result",
      ].sort(),
    );
  });

  it("anonymizes PII in user messages on context_with_system", async () => {
    const startHandler = mock.handlers.find((h) => h.name === "session_start");
    expect(startHandler).toBeDefined();
    await startHandler!.handler({}, mock.ctx);

    const handler = eventHandler(mock, "context_with_system");
    const event: ContextWithSystemEvent = {
      type: "context_with_system",
      messages: [
        {
          role: "user",
          content: `Use this key: ${TEST_SECRET}`,
          timestamp: 0,
        } as never,
      ],
    };
    await handler(event, mock.ctx);

    const userText = (event.messages[0] as { content: string }).content;
    expect(userText).not.toContain(TEST_SECRET);
    expect(userText).toContain("<PII");
  });

  it("anonymizes tool result text on tool_result", async () => {
    const startHandler = mock.handlers.find((h) => h.name === "session_start")!;
    await startHandler.handler({}, mock.ctx);

    const ctxHandler = eventHandler(mock, "context_with_system");
    await ctxHandler(
      {
        type: "context_with_system",
        messages: [{ role: "user", content: "ready", timestamp: 0 } as never],
      } as ContextWithSystemEvent,
      mock.ctx,
    );

    const toolHandler = eventHandler(mock, "tool_result");
    const event: ToolResultEvent = {
      type: "tool_result",
      toolCallId: "call-2",
      toolName: "bash",
      input: {},
      content: [{ type: "text", text: `Config loaded: API_KEY=${TEST_SECRET}` }],
      isError: false,
    } as ToolResultEvent;
    const result = (await toolHandler(event, mock.ctx)) as
      | { content?: { type: string; text: string }[] }
      | undefined;
    expect(result).toBeDefined();
    const replaced = (result!.content ?? event.content)[0] as { text: string };
    expect(replaced.text).not.toContain(TEST_SECRET);
    expect(replaced.text).toContain("<PII");
  });

  it("leaves assistant text unchanged when no PII tags are present", async () => {
    const startHandler = mock.handlers.find((h) => h.name === "session_start")!;
    await startHandler.handler({}, mock.ctx);

    const handler = eventHandler(mock, "tool_call");
    const event: ToolCallEvent = {
      type: "tool_call",
      toolCallId: "call-3",
      toolName: "bash",
      input: { command: "echo hello world" } as never,
    } as ToolCallEvent;
    await handler(event, mock.ctx);
    // 不含 tag 的入参保持原样。
    expect((event.input as { command: string }).command).toBe("echo hello world");
  });
  it("keeps multi-text-block toolResult stable across repeated context scrubs", async () => {
    const startHandler = mock.handlers.find((h) => h.name === "session_start")!;
    await startHandler.handler({}, mock.ctx);

    const messages = [
      { role: "user", content: "go", timestamp: 0 },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-9", arguments: { command: "cat a.txt" } },
        ],
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call-9",
        content: [
          { type: "text", text: `value=${TEST_SECRET}` },
          { type: "text", text: "second block" },
        ],
        timestamp: 0,
      },
    ];

    const handler = eventHandler(mock, "context_with_system");
    const event = {
      type: "context_with_system",
      messages,
    } as unknown as ContextWithSystemEvent;
    await handler(event, mock.ctx);

    const blocks = () =>
      (messages[2] as { content: { type: string; text: string }[] }).content;
    expect(blocks()).toHaveLength(2);
    expect(blocks()[0]!.text).not.toContain(TEST_SECRET);
    expect(blocks()[0]!.text).toContain("<PII");
    expect(blocks()[1]!.text).toBe("second block");

    // 第二轮全量重扫历史：块结构与文本必须保持不变（不合并、不累积尾换行）
    const afterFirst = blocks().map((b) => b.text);
    await handler(event, mock.ctx);
    expect(blocks()).toHaveLength(2);
    expect(blocks().map((b) => b.text)).toEqual(afterFirst);
  });
});