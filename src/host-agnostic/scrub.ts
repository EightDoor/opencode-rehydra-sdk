/**
 * 宿主无关的脱敏核心。
 *
 * 该模块封装了把任意 JSON 树中的字符串递归匿名化的流程，且不绑定到
 * OpenCode / Pi 等具体宿主。其设计要点：
 *
 * - 接受一个轻量 {@link ScrubHost} 抽象，由宿主提供日志与命令反查能力。
 * - 递归扫描一份克隆出来的消息树，整个过程成功后才把结果回写到原始对象，
 *   避免半脱敏状态下把原始 PII 漏给模型（fail-closed）。
 * - 共享核心里只关心"对每个字符串调用 `session.anonymize()`"，策略由宿主
 *   通过 `applyIdentityPolicy` 自行合并。
 *
 * 仅依赖项目内的 `AnonymizerSessionImpl` 和 PII 类型，不引用任何宿主 SDK。
 */
import type {
  AnonymizationPolicy,
} from "../types/index.js";
import type { AnonymizerSessionImpl } from "../storage/session-base.js";

/** 宿主暴露给共享脱敏核心的回调集合。 */
export interface ScrubHost {
  /** 当前正在被脱敏的会话 ID，用于诊断日志。 */
  readonly sessionID: string;
  /** 宿主提供的 logger；函数必须吞掉自己的异常。 */
  readonly log: HostLogger;
  /**
   * 从 `tool-call` part 的 `input` 中抽取 shell 命令字符串。
   * 宿主无法识别时返回 `undefined`。
   */
  extractCommand(input: unknown): string | undefined;
  /**
   * 给定 `tool-result` part 的 callID，查询之前记录的 `tool-call` 命令。
   * 用于按命令历史决定当前 `tool-result` 是否要走 VCS 身份策略。
   */
  commandForPart(callID: string | undefined): string | undefined;
  /**
   * 记录一个 `tool-call` 的 callID 与对应 shell 命令，方便后续
   * `tool-result` 反查。
   */
  recordCommand(callID: string | undefined, command: string | undefined): void;
  /**
   * 给定 `tool-call` / `tool-result` part 的 shell 命令，返回一个策略：
   * 如果命令需要启用额外的 VCS 身份识别，返回叠加后的策略；否则原样
   * 返回 `base`。宿主可在此关闭 `URL` 等默认类型、启用 `PERSON`、
   * 启用 `GITHUB_USERNAME` 等。
   */
  applyIdentityPolicy(
    base: Partial<AnonymizationPolicy> | undefined,
    command: string | undefined,
  ): Partial<AnonymizationPolicy>;
}

/** 与 OpenCode 共享 logger 兼容的最小接口。 */
export interface HostLogger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

/** 共享核心的运行配置。 */
export interface ScrubCoreOptions {
  /** 透传给 `session.anonymize()` 的 locale 提示。 */
  locale?: string;
  /** 默认脱敏策略；每个 part 都会再叠加自己的策略增量。 */
  policy?: Partial<AnonymizationPolicy>;
}

/** 一个 part（V2 `content` 或 V1 `parts`）的最小可写接口。 */
export interface ScrubPart {
  type?: string;
  id?: string;
  callID?: string;
  text?: unknown;
  input?: unknown;
  result?: unknown;
  state?: ScrubPartState;
  [key: string]: unknown;
}

/** V1 风格的 part state（用于兼容历史 OpenCode message）。 */
export interface ScrubPartState {
  status?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

/** 一条消息：宿主可以暴露 `content` 或 `parts`（或两者兼有）。 */
export interface ScrubMessage {
  content?: ScrubPart[];
  parts?: ScrubPart[];
  info?: { sessionID?: string; [key: string]: unknown };
  sessionID?: string;
  [key: string]: unknown;
}

/** 一次脱敏的统计结果。 */
export interface ScrubCoreStats {
  scrubbed: number;
  byType: Record<string, number>;
}

/** 把字符串按策略过一道匿名化。 */
async function scrubString(
  text: string,
  session: AnonymizerSessionImpl,
  policy: Partial<AnonymizationPolicy> | undefined,
  locale: string | undefined,
  stats: { count: number; byType: Record<string, number> },
): Promise<string> {
  const result = await session.anonymize(text, locale, policy);
  if (result.stats.totalEntities > 0) {
    stats.count += result.stats.totalEntities;
    for (const [type, count] of Object.entries(result.stats.countsByType)) {
      stats.byType[type] = (stats.byType[type] ?? 0) + count;
    }
  }
  return result.anonymizedText;
}

/** 深度克隆 JSON-like 值（消息载荷不含类实例）。 */
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => deepClone(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      out[key] = deepClone(item);
    }
    return out as T;
  }
  return value;
}

/** 递归脱敏任意 JSON-like 值。 */
async function scrubValue(
  value: unknown,
  session: AnonymizerSessionImpl,
  basePolicy: Partial<AnonymizationPolicy> | undefined,
  locale: string | undefined,
  stats: { count: number; byType: Record<string, number> },
): Promise<unknown> {
  if (typeof value === "string") {
    return scrubString(value, session, basePolicy, locale, stats);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(await scrubValue(item, session, basePolicy, locale, stats));
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      out[key] = await scrubValue(item, session, basePolicy, locale, stats);
    }
    return out;
  }
  return value;
}

/** 同步处理 part 的所有字段。 */
async function scrubPart(
  part: ScrubPart,
  session: AnonymizerSessionImpl,
  host: ScrubHost,
  options: ScrubCoreOptions,
  stats: { count: number; byType: Record<string, number> },
): Promise<void> {
  // V1 part state 兼容。
  const partState = part.state;
  if (partState !== undefined && partState !== null && typeof partState === "object") {
    if (partState.input !== undefined) {
      const command = host.extractCommand(partState.input);
      if (command !== undefined) {
        host.recordCommand(part.callID ?? part.id, command);
      }
      partState.input = await scrubValue(
        partState.input,
        session,
        options.policy,
        options.locale,
        stats,
      );
    }
    if (typeof partState.error === "string") {
      partState.error = await scrubString(
        partState.error,
        session,
        options.policy,
        options.locale,
        stats,
      );
    }
    if (
      partState.status === "completed" &&
      typeof partState.output === "string"
    ) {
      const command =
        host.extractCommand(partState.input) ??
        host.commandForPart(part.callID ?? part.id);
      const policy = host.applyIdentityPolicy(options.policy, command);
      partState.output = await scrubString(
        partState.output,
        session,
        policy,
        options.locale,
        stats,
      );
    }
  }

  // V2 tool-call input。
  if (part.type === "tool-call" && part.input !== undefined) {
    const command = host.extractCommand(part.input);
    if (command !== undefined && part.id !== undefined) {
      host.recordCommand(part.id, command);
    }
    part.input = await scrubValue(
      part.input,
      session,
      options.policy,
      options.locale,
      stats,
    );
  }

  // V2 tool-result output。
  if (part.type === "tool-result" && part.result !== undefined) {
    const command =
      host.extractCommand(part.input) ??
      host.commandForPart(part.callID ?? part.id);
    const policy = host.applyIdentityPolicy(options.policy, command);
    part.result = await scrubValue(
      part.result,
      session,
      policy,
      options.locale,
      stats,
    );
  }

  // 任意字符串 part（text / reasoning / compaction）。
  if (typeof part.text === "string") {
    part.text = await scrubString(
      part.text,
      session,
      options.policy,
      options.locale,
      stats,
    );
  }
}

/** 把扫描结果写回到原始消息对象（保留对象引用）。 */
function restoreParts(
  original: ScrubMessage,
  scrubbed: ScrubMessage,
): void {
  if (Array.isArray(original.content) && Array.isArray(scrubbed.content)) {
    restorePartArray(original.content, scrubbed.content);
  }
  if (Array.isArray(original.parts) && Array.isArray(scrubbed.parts)) {
    restorePartArray(original.parts, scrubbed.parts);
  }
}

function restorePartArray(
  originalParts: ScrubPart[] | undefined,
  scrubbedParts: ScrubPart[] | undefined,
): void {
  if (!Array.isArray(originalParts) || !Array.isArray(scrubbedParts)) return;
  const length = Math.min(originalParts.length, scrubbedParts.length);
  for (let index = 0; index < length; index++) {
    restorePart(originalParts[index], scrubbedParts[index]);
  }
}

function restorePart(
  original: ScrubPart | undefined,
  scrubbed: ScrubPart | undefined,
): void {
  if (original === undefined || scrubbed === undefined) return;
  original.text = scrubbed.text;
  original.input = scrubbed.input;
  original.result = scrubbed.result;
  restorePartState(original.state, scrubbed.state);
}

function restorePartState(
  original: ScrubPartState | undefined,
  scrubbed: ScrubPartState | undefined,
): void {
  if (original === undefined || scrubbed === undefined) return;
  original.input = scrubbed.input;
  original.error = scrubbed.error;
  original.output = scrubbed.output;
}

/**
 * 核心入口：对一组 `messages` 做脱敏。
 *
 * 流程：
 * 1. 深克隆出工作副本；
 * 2. 扫描每个 part，按需启用 VCS 身份策略；
 * 3. 整个扫描成功完成后，把改动回写到传入的原始对象；
 * 4. 失败则保持原对象不动，调用方负责 fail-closed。
 */
export async function scrubCore(
  messages: readonly ScrubMessage[],
  session: AnonymizerSessionImpl,
  host: ScrubHost,
  options: ScrubCoreOptions,
): Promise<ScrubCoreStats> {
  const workingMessages = messages.map((m) => deepClone(m));
  const stats = { count: 0, byType: {} as Record<string, number> };

  for (const message of workingMessages) {
    if (message === null || typeof message !== "object") continue;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part !== null && typeof part === "object") {
          await scrubPart(part, session, host, options, stats);
        }
      }
    }
    if (Array.isArray(message.parts)) {
      for (const part of message.parts) {
        if (part !== null && typeof part === "object") {
          await scrubPart(part, session, host, options, stats);
        }
      }
    }
  }

  for (let index = 0; index < messages.length; index++) {
    const original = messages[index];
    const scrubbed = workingMessages[index];
    if (original === undefined || scrubbed === undefined) continue;
    restoreParts(original, scrubbed);
  }

  if (stats.count > 0) {
    const nonZero: Record<string, number> = {};
    for (const [type, count] of Object.entries(stats.byType)) {
      if (count > 0) nonZero[type] = count;
    }
    host.log.info(`scrubbed ${stats.count} secret(s) from messages`, {
      scrubbed: nonZero,
      messageCount: messages.length,
    });
  } else {
    host.log.debug("no secrets found in messages", {
      messageCount: messages.length,
    });
  }

  return { scrubbed: stats.count, byType: stats.byType };
}