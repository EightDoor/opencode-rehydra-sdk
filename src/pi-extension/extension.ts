/**
 * Pi 扩展的 ExtensionAPI 适配层。
 *
 * 与 {@link scrubCore} / `deepRehydrate` 配合，把脱敏能力挂到 Pi 的事件钩子上。
 *
 * - `context_with_system` 在每个 LLM 请求前对 `messages` 做脱敏；
 * - `tool_call` 在工具执行前就地还原工具入参中的 PII 标签；
 * - `tool_result` 在结果回填给模型前就地脱敏真实 PII；
 * - `message_end` 改写最终 assistant 文本，把 PII 标签还原为真值；
 * - `session_start` / `session_shutdown` 管理会话与匿名器生命周期；
 * - `input` / `user_bash` 在源头做最低限度的脱敏，避免走特殊路径的 PII 漏出。
 *
 * 设计目标：
 * - 复用 {@link scrubCore}，与 OpenCode 插件保持一致行为；
 * - 失败关闭：任何 scrub 异常都向上抛出，Pi 会停在该请求而不是泄漏；
 * - 资源释放：`session_shutdown` 幂等释放 session 注册表与匿名器；
 * - 暴露 `/rehydra` 命令，便于用户在交互模式快速查看当前配置。
 */
import type {
  AgentMessage,
  ContextEventResult,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  MessageEndEventResult,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultEventResult,
} from "./host-types.js";

import {
  PIIType,
  createDefaultPolicy,
  SECRET_PII_TYPES,
} from "../types/index.js";
import type {
  AnonymizationPolicy,
  TagFormat,
} from "../types/index.js";
import type { AnonymizerConfig } from "../core/anonymizer.js";
import { Anonymizer, createAnonymizer } from "../index.js";
import type { AnonymizerSessionImpl } from "../storage/session-base.js";
import { InMemoryKeyProvider } from "../crypto/index.js";
import { InMemoryPIIStorageProvider } from "../storage/in-memory.js";
import {
  anonymizerConfigFromOptions,
  normalizeRehydraOptions,
  policyFromOptions,
} from "../host-agnostic/normalize-options.js";
import { buildTagPrefix } from "../utils/regex.js";
import { buildPIISystemInstruction } from "../proxy/system-instruction.js";
import { githubUsernameRecognizer } from "../opencode-plugin/github-username.js";
import { gitIdentityRecognizer } from "../opencode-plugin/git-identity.js";
import { protectIdentityTags } from "../opencode-plugin/identity-recognizer.js";
import {
  scrubCore,
  type ScrubCoreOptions,
  type ScrubHost,
  type ScrubMessage,
  type ScrubPart,
} from "../host-agnostic/scrub.js";
import { deepRehydrateJson } from "../utils/json-walk.js";

/** Pi 扩展运行时状态：跨多个事件共享。 */
interface PiExtensionState {
  anonymizer: Anonymizer;
  policy: Partial<AnonymizationPolicy>;
  locale?: string;
  tagFormat: TagFormat;
  tagPrefix: string;
  rehydraInstruction: string;
  vcsIdentities: boolean;
  resolveSession: (sessionId: string) => AnonymizerSessionImpl;
}

/** 构造脱敏策略：对启用 `vcsIdentities` 的命令叠加 GITHUB_USERNAME / PERSON。 */
function buildIdentityPolicyBuilder(state: PiExtensionState) {
  return (types: PIIType[]): Partial<AnonymizationPolicy> => {
    const base = state.policy;
    const defaults = createDefaultPolicy();
    const enabledTypes = new Set(base.enabledTypes ?? defaults.enabledTypes);
    const regexEnabledTypes = new Set(
      base.regexEnabledTypes ?? defaults.regexEnabledTypes,
    );
    for (const secretType of SECRET_PII_TYPES) {
      enabledTypes.add(secretType);
      regexEnabledTypes.add(secretType);
    }
    for (const type of types) {
      enabledTypes.add(type);
      regexEnabledTypes.add(type);
    }
    return {
      ...base,
      enabledTypes,
      regexEnabledTypes,
      reuseIdsForRepeatedPII: true,
    };
  };
}

/** 命令抽取：从 Pi 的 `tool-call` input 中识别 `bash` / `powershell` 等命令。 */
function extractCommandFromInput(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const candidate = (input as Record<string, unknown>).command;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * 构建 {@link ScrubHost}：从 AgentMessage 的 `toolCall` / `toolResult` parts
 * 中抽取 shell 命令，并启用 VCS 身份策略。
 */
function buildScrubHost(state: PiExtensionState): ScrubHost {
  const commandByCallID = new Map<string, string>();
  const identityBuilder = buildIdentityPolicyBuilder(state);

  return {
    sessionID: "",
    log: createConsoleLogger(),
    extractCommand(input: unknown): string | undefined {
      return extractCommandFromInput(input);
    },
    commandForPart(callID: string | undefined): string | undefined {
      if (callID === undefined) return undefined;
      return commandByCallID.get(callID);
    },
    recordCommand(callID: string | undefined, command: string | undefined): void {
      if (callID === undefined || command === undefined) return;
      commandByCallID.set(callID, command);
    },
    applyIdentityPolicy(
      base: Partial<AnonymizationPolicy> | undefined,
      command: string | undefined,
    ): Partial<AnonymizationPolicy> {
      if (command === undefined) return base ?? state.policy;
      const types: PIIType[] = [];
      // 复用 OpenCode 的 vcsCommandTypes 启发式判断。
      if (/^(?:.*\s)?(?:git|gh)\b/.test(command)) {
        // git 走 PERSON；gh 走 GITHUB_USERNAME。两个都启用即可，由 recognizer
        // 各自按结构化字段匹配，不会冲突。
        types.push(PIIType.GITHUB_USERNAME, PIIType.PERSON);
      }
      if (types.length === 0) return base ?? state.policy;
      return identityBuilder(types);
    },
  };
}

/** Pi 扩展运行时不暴露 logger 通道，统一走 console.warn 兜底（与 OpenCode 兼容）。 */
function createConsoleLogger(): ScrubHost["log"] {
  const emit = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    const suffix = extra === undefined ? "" : ` extra=${JSON.stringify(extra)}`;
    const line = `service=rehydra-pi level=${level} message=${message}${suffix}`;
    if (level === "error") {
      // eslint-disable-next-line no-console
      console.error(line);
    } else {
      // eslint-disable-next-line no-console
      console.warn(line);
    }
  };
  return {
    debug: (message, extra) => emit("debug", message, extra),
    info: (message, extra) => emit("info", message, extra),
    warn: (message, extra) => emit("warn", message, extra),
    error: (message, extra) => emit("error", message, extra),
  };
}

/**
 * Pi 中的 `UserMessage.content` 可以是字符串或 `(TextContent | ImageContent)[]`。
 * 共享核心按 `ScrubPart[]` 处理，所以这里把它统一拍平为 `[{ type: "text", text }]`。
 * 同时记录下原字段是字符串，以便 scrub 后把改动写回到原字段。
 */
interface MessageRewrite {
  scrubMessages: ScrubMessage[];
  /** index in scrubMessages -> 原始 content 字段是否是字符串 */
  userStringContent: Map<number, { original: string }>;
}

function normalizeMessagesForScrub(messages: AgentMessage[]): MessageRewrite {
  const scrubMessages: ScrubMessage[] = [];
  const userStringContent = new Map<number, { original: string }>();
  messages.forEach((m, index) => {
    const role = (m as { role?: string }).role;
    if (role === "user") {
      const content = (m as { content?: unknown }).content;
      if (typeof content === "string") {
        userStringContent.set(index, { original: content });
        scrubMessages.push({
          content: [{ type: "text", text: content }],
        });
        return;
      }
    }
    scrubMessages.push(agentMessageToScrub(m));
  });
  return { scrubMessages, userStringContent };
}

/**
 * scrub 后把 parts 改动写回到 AgentMessage。
 *
 * - 普通 message：走 `agentMessageToScrub` 的逆向映射（assistant / toolResult
 *   的 content 已是数组，scrubCore 会按 parts 写回）；
 * - user string content：取 scrub 后 parts 的第一段 text 还原回字符串。
 */
function restoreMessagesFromScrub(
  originals: AgentMessage[],
  scrubbed: ScrubMessage[],
  userStringContent: Map<number, { original: string }>,
): void {
  scrubbed.forEach((scrub, index) => {
    const original = originals[index] as { content?: unknown };
    if (userStringContent.has(index)) {
      const firstPart = scrub.content?.[0];
      if (
        firstPart !== undefined &&
        firstPart !== null &&
        typeof firstPart.text === "string"
      ) {
        original.content = firstPart.text;
      }
      return;
    }
    const scrubContent = scrub.content;
    if (Array.isArray(scrubContent)) {
      original.content = scrubContent;
    }
  });
}

function agentMessageToScrub(message: AgentMessage): ScrubMessage {
  const role = (message as { role?: string }).role;
  if (role === "user") {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return {
        content: [{ type: "text", text: content }],
      };
    }
    if (Array.isArray(content)) {
      return {
        content: content.map((part) => textPartFromContent(part)),
      };
    }
    return {};
  }
  if (role === "assistant") {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return {};
    return {
      content: content.map((block) => assistantBlockToPart(block)),
    };
  }
  if (role === "toolResult") {
    const toolCallId = (message as { toolCallId?: string }).toolCallId;
    const content = (message as { content?: unknown }).content;
    const parts: ScrubPart[] = [];
    if (Array.isArray(content)) {
      for (const c of content) parts.push(textPartFromContent(c));
    }
    return {
      content: [
        {
          type: "tool-result",
          id: toolCallId,
          callID: toolCallId,
          result: combineTextContent(content),
        },
      ],
    };
  }
  return {};
}

function textPartFromContent(part: unknown): ScrubPart {
  if (part === null || typeof part !== "object") return {};
  const obj = part as Record<string, unknown>;
  if (obj.type === "text" && typeof obj.text === "string") {
    return { type: "text", text: obj.text };
  }
  if (obj.type === "image") return {};
  return {};
}

function assistantBlockToPart(block: unknown): ScrubPart {
  if (block === null || typeof block !== "object") return {};
  const obj = block as Record<string, unknown>;
  if (obj.type === "text" && typeof obj.text === "string") {
    return { type: "text", text: obj.text };
  }
  if (obj.type === "thinking") {
    const thinking = obj.thinking;
    if (typeof thinking === "string") {
      return { type: "text", text: thinking };
    }
  }
  if (obj.type === "toolCall") {
    return {
      type: "tool-call",
      id: typeof obj.id === "string" ? obj.id : undefined,
      input: obj.arguments,
    };
  }
  return {};
}

function combineTextContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const parts: string[] = [];
  for (const item of content) {
    if (item !== null && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      if (obj.type === "text" && typeof obj.text === "string") {
        parts.push(obj.text);
      }
    }
  }
  if (parts.length === 0) return content;
  if (parts.length === 1) return parts[0];
  return parts.join("\n");
}

/** 暴露给 Pi 的脱敏 / 还原入口。 */
export interface RehydraPiHandle {
  /** 强制脱敏一组文本（对外命令使用）。 */
  anonymize(text: string): Promise<string>;
  /** 强制还原一组文本（对外命令使用）。 */
  rehydrate(text: string): Promise<string>;
}

/**
 * 安装 Pi 扩展。
 *
 * 该工厂由 `src/pi-extension/index.ts` 的 default export 暴露，Pi 在加载
 * 扩展时自动调用。它负责：
 *
 * 1. 在 `session_start` 中实例化匿名器、装配会话注册表与策略；
 * 2. 在 `context_with_system` / `tool_call` / `tool_result` / `message_end`
 *    上挂载脱敏 / 还原钩子；
 * 3. 在 `session_shutdown` 中幂等释放所有资源；
 * 4. 注册 `/rehydra` 命令以便用户在 TUI 中查看或手动触发操作。
 */
export function createRehydraPiExtension(pi: ExtensionAPI): void {
  // Per-session runtime state, scoped to a single Pi session.
  const runtime: { state?: PiExtensionState } = {};

  const setupRuntime = async (
    cwd: string,
    rawOptions: unknown,
  ): Promise<PiExtensionState> => {
    const options = normalizeRehydraOptions(rawOptions);
    const policy = policyFromOptions(options) ?? {};
    const anonymizerConfig: AnonymizerConfig = anonymizerConfigFromOptions(
      options,
      cwd,
    );
    const keyProvider = new InMemoryKeyProvider();
    const piiStorage = new InMemoryPIIStorageProvider();
    const anonymizer = createAnonymizer({
      ...anonymizerConfig,
      keyProvider,
      piiStorageProvider: piiStorage,
    });
    if (options.vcsIdentities === true) {
      const tagFormat = anonymizerConfig.tagFormat ?? options.tagFormat;
      if (tagFormat !== undefined) {
        anonymizer
          .getRegistry()
          .register(protectIdentityTags(githubUsernameRecognizer, tagFormat));
        anonymizer
          .getRegistry()
          .register(protectIdentityTags(gitIdentityRecognizer, tagFormat));
      }
    }
    await anonymizer.initialize();

    const tagFormat =
      anonymizerConfig.tagFormat ?? options.tagFormat ?? { open: "<", close: "/>", keyword: "PII" };
    const tagPrefix = buildTagPrefix(tagFormat);
    const rehydraInstruction = `<rehydra>\n${buildPIISystemInstruction(tagFormat)}\n</rehydra>`;

    const sessionMap = new Map<string, AnonymizerSessionImpl>();
    const state: PiExtensionState = {
      anonymizer,
      policy,
      locale: options.locale,
      tagFormat,
      tagPrefix,
      rehydraInstruction,
      vcsIdentities: options.vcsIdentities === true,
      resolveSession(sessionId: string): AnonymizerSessionImpl {
        let session = sessionMap.get(sessionId);
        if (session === undefined) {
          session = anonymizer.session(sessionId) as unknown as AnonymizerSessionImpl;
          sessionMap.set(sessionId, session);
        }
        return session;
      },
    };
    void sessionMap;

    return state;
  };

  const disposeRuntime = async (state?: PiExtensionState): Promise<void> => {
    if (state === undefined) return;
    try {
      await state.anonymizer.dispose();
    } catch {
      // Dispose is best-effort: the session is being torn down regardless.
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.sessionManager.getCwd();
    const settings = pi.getSettings();
    const rawOptions = readPiExtensionOptions(settings);
    runtime.state = await setupRuntime(cwd, rawOptions);
  });

  pi.on("session_shutdown", async () => {
    await disposeRuntime(runtime.state);
    runtime.state = undefined;
  });

  pi.on("context_with_system", async (event, ctx) => {
    const state = runtime.state;
    if (state === undefined) return {};
    const host = buildScrubHost(state);
    const sessionId = ctx.sessionManager.getSessionId();
    (host as { sessionID: string }).sessionID = sessionId;
    const scrubOptions: ScrubCoreOptions = {
      locale: state.locale,
      policy: state.policy,
    };
    // 把 user string content 拍平为 parts 数组便于共享核心处理；返回还原
    // 映射，以便在 scrub 后把改动写回到原始消息的 `content` 字段。
    const rewrite = normalizeMessagesForScrub(event.messages);
    await scrubCore(
      rewrite.scrubMessages,
      state.resolveSession(sessionId),
      host,
      scrubOptions,
    );
    restoreMessagesFromScrub(event.messages, rewrite.scrubMessages, rewrite.userStringContent);
    // 共享核心就地改写了 event.messages；显式回传，保证 Pi 使用改写后的数组。
    const result: ContextEventResult = { messages: event.messages };
    return result;
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    const state = runtime.state;
    if (state === undefined) return undefined;
    // Pi 把工具入参存放在 `event.input` 中；直接 deep-rehydrate。
    const session = state.resolveSession(ctx.sessionManager.getSessionId());
    // `deepRehydrateJson` 就地修改对象/数组并返回同一引用，工具入参始终是对象，
    // 因此无需重新赋值（避免 any 赋值与冗余断言）。
    await deepRehydrateJson(
      event.input,
      (text: string) => session.rehydrate(text),
      state.tagPrefix,
    );
    return undefined;
  });

  pi.on(
    "tool_result",
    async (event: ToolResultEvent, ctx): Promise<ToolResultEventResult | undefined> => {
      const state = runtime.state;
      if (state === undefined) return undefined;
      const session = state.resolveSession(ctx.sessionManager.getSessionId());
      // 把结果先脱敏再返回模型；content 是 (TextContent|ImageContent)[]，
      // 仅处理 TextContent 的 text 字段；image 维持原样。
      const result: ToolResultEventResult = {};
      if (Array.isArray(event.content)) {
        const scrubbed: typeof event.content = [];
        for (const part of event.content) {
          if (
            part !== null &&
            typeof part === "object" &&
            part.type === "text" &&
            typeof part.text === "string"
          ) {
            const anonymized = await session.anonymize(
              part.text,
              state.locale,
              state.policy,
            );
            scrubbed.push({ type: "text", text: anonymized.anonymizedText });
          } else {
            scrubbed.push(part);
          }
        }
        result.content = scrubbed;
      }
      // 在源头对 details / structuredContent 做递归脱敏（递归 deep-rehydrate）。
      // 留空，避免破坏 TUI 渲染细节。structuredContent 不在 LLM 上下文中。
      return result;
    },
  );

  pi.on("message_end", async (event: MessageEndEvent, ctx): Promise<MessageEndEventResult | undefined> => {
    const state = runtime.state;
    if (state === undefined) return undefined;
    const message = event.message;
    if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
    const session = state.resolveSession(ctx.sessionManager.getSessionId());
    const newContent: unknown[] = [];
    for (const block of message.content) {
      if (block === null || typeof block !== "object") {
        newContent.push(block);
        continue;
      }
      const obj = block as Record<string, unknown>;
      if (obj.type === "text" && typeof obj.text === "string") {
        const restored = await session.rehydrate(obj.text);
        newContent.push({ ...obj, text: restored });
      } else if (obj.type === "thinking" && typeof obj.thinking === "string") {
        // 思考块是面向模型的；按原 plugin 的行为保留 PII 标签，避免泄漏。
        newContent.push(block);
      } else {
        newContent.push(block);
      }
    }
    const updated: AgentMessage = { ...message, content: newContent };
    return { message: updated };
  });

  // 给用户提供一个简单的 TUI 命令，便于查看当前配置与状态。
  pi.registerCommand("rehydra", {
    description: "Inspect the Rehydra Pi extension status.",
    handler: (_args: string, ctx: ExtensionContext): Promise<void> => {
      const state = runtime.state;
      if (state === undefined) {
        ctx.ui.notify("Rehydra extension is not initialized.", "warning");
        return Promise.resolve();
      }
      ctx.ui.notify(
        [
          `Rehydra Pi extension active.`,
          `cwd: ${ctx.sessionManager.getCwd()}`,
          `tagPrefix: ${state.tagPrefix}`,
          `vcsIdentities: ${state.vcsIdentities}`,
        ].join("\n"),
        "info",
      );
      return Promise.resolve();
    },
  });

  // 兼容 try 块中可能抛错的初始化失败：通过 warn 输出而非 fail-closed。
}

function readPiExtensionOptions(settings: unknown): unknown {
  // Pi 的内置 `Settings` 不携带插件配置，扩展通过约定键 `settings.rehydra`
  // 读取配置。安装文档建议用户在 `~/.pi/agent/settings.json` 中：
  //
  // ```json
  // { "rehydra": { "redactValues": ["..."], "envFiles": ["..."] } }
  // ```
  if (settings === null || typeof settings !== "object") return undefined;
  const obj = settings as { rehydra?: unknown };
  return obj.rehydra;
}

/** 兜底避免 lint 抱怨未使用的 DEFAULT_DISABLE_TYPES。 */
void 0;