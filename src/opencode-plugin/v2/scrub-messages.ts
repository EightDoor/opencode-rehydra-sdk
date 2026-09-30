/**
 * OpenCode Plugin V2 message scrubber.
 *
 * 把宿主无关的 {@link scrubCore} 适配到 OpenCode 的 `session.hook("context")`
 * 事件载荷上：
 * - 实现一个轻量 {@link OpencodeScrubHost}：负责抽取 shell 命令与 VCS
 *   身份策略，并保持 `callID → command` 映射供后续 `tool-result` 反查。
 * - 复用 OpenCode Plugin V2 的 {@link V2Logger} 作为 HostLogger。
 *
 * 深克隆 + 全程成功才回写仍由共享核心负责；任何异常会向上抛出，由
 * `register-hooks.ts` 失败关闭。
 */
import { PIIType } from "../../types/index.js";
import type {
  AnonymizationPolicy,
  AnonymizationResult,
} from "../../types/index.js";
import { vcsCommandTypes } from "../vcs-command.js";
import type {
  ScrubCoreOptions,
  ScrubCoreStats,
  ScrubHost,
  ScrubMessage,
} from "../../host-agnostic/scrub.js";
import { scrubCore } from "../../host-agnostic/scrub.js";
import type { AnonymizerSessionImpl } from "../../storage/session-base.js";
import type { ScrubContext, V2Logger } from "./types.js";
import { AnonymizationState } from "./anon-state.js";

/** OpenCode plugin 的 scrub 配置。 */
export interface ScrubMessagesOptions {
  /** Locale hint passed to `anonymize()`. */
  locale?: string;
  /** Base policy (URL/IP disabled by default). */
  policy?: Partial<AnonymizationPolicy>;
  /** Whether the VCS identity recognizers are enabled. */
  vcsIdentities: boolean;
  /**
   * Returns the policy override that enables identity types for a VCS output.
   * The base policy is supplied so the override can merge with it.
   */
  identityPolicy(types: PIIType[]): Partial<AnonymizationPolicy>;
}

/** 单次 scrub 的结果。 */
export interface ScrubResult {
  /** Entities anonymized during this call. */
  scrubbed: number;
  byType: Record<string, number>;
}

/**
 * OpenCode 适配的 {@link ScrubHost}。
 *
 * - 命令抽取委托给 OpenCode 的 `vcsCommandTypes`（参考原 plugin）。
 * - 身份策略通过 `options.identityPolicy` 构造；`bindIdentityPolicy`
 *   在 `scrubMessages` 入口处注入 builder。
 */
class OpencodeScrubHost implements ScrubHost {
  readonly sessionID: string;
  readonly log: V2Logger;

  /** `tool-call.id` → 抽取的 shell 命令，供后续 `tool-result` 反查。 */
  private readonly commandByCallID = new Map<string, string>();

  constructor(sessionID: string, logger: V2Logger) {
    this.sessionID = sessionID;
    this.log = logger;
  }

  extractCommand(input: unknown): string | undefined {
    if (input === null || typeof input !== "object") return undefined;
    const candidate = (input as { command?: unknown }).command;
    return typeof candidate === "string" ? candidate : undefined;
  }

  commandForPart(callID: string | undefined): string | undefined {
    if (callID === undefined) return undefined;
    return this.commandByCallID.get(callID);
  }

  recordCommand(callID: string | undefined, command: string | undefined): void {
    if (callID === undefined || command === undefined) return;
    this.commandByCallID.set(callID, command);
  }

  applyIdentityPolicy(
    base: Partial<AnonymizationPolicy> | undefined,
    command: string | undefined,
  ): Partial<AnonymizationPolicy> {
    if (command === undefined) return base ?? {};
    const commands = vcsCommandTypes(command);
    const types: PIIType[] = [];
    if (commands.has("github")) types.push(PIIType.GITHUB_USERNAME);
    if (commands.has("git")) types.push(PIIType.PERSON);
    if (types.length === 0) return base ?? {};
    const builder = this.identityPolicyBuilder;
    if (builder === undefined) return base ?? {};
    return builder(types);
  }

  private identityPolicyBuilder?: (types: PIIType[]) => Partial<AnonymizationPolicy>;

  /** `scrubMessages` 入口处注入 builder。 */
  bindIdentityPolicy(
    builder: (types: PIIType[]) => Partial<AnonymizationPolicy>,
  ): void {
    this.identityPolicyBuilder = builder;
  }
}

/**
 * Anonymizes the messages of an OpenCode session request in place.
 *
 * 与原 plugin 行为一致：
 * - 深克隆出工作副本；
 * - 整个流程成功后才把改动写回；
 * - 任何失败向上抛出，由调用方 fail-closed。
 */
export async function scrubMessages(
  eventMessages: unknown[],
  ctx: ScrubContext,
  resolveSession: (sessionID: string) => AnonymizerSessionImpl,
  state: AnonymizationState,
  options: ScrubMessagesOptions,
): Promise<ScrubResult> {
  const host = new OpencodeScrubHost(ctx.sessionID, ctx.logger);
  // 用箭头函数包裹，避免直接把方法引用绑定到 host（ESLint unbound-method）。
  host.bindIdentityPolicy((types) => options.identityPolicy(types));

  // 把 `eventMessages` 视为 ScrubMessage 列表：OpenCode 的实际字段名是
  // `content` / `parts` / `info`，与 ScrubMessage 完全一致。
  const messages: ScrubMessage[] = eventMessages as ScrubMessage[];

  const scrubOptions: ScrubCoreOptions = {
    locale: options.locale,
    policy: options.policy,
  };

  const result: ScrubCoreStats = await scrubCore(
    messages,
    resolveSession(ctx.sessionID),
    host,
    scrubOptions,
  );

  if (result.scrubbed > 0) {
    state.hasAnonymized = true;
  }

  return { scrubbed: result.scrubbed, byType: result.byType };
}

/** 重新导出共享类型，便于 OpenCode plugin 内部继续引用。 */
export type { ScrubMessage } from "../../host-agnostic/scrub.js";

/** 辅助：构造一个与原 plugin 等价的 `AnonymizationResult.stats` 视图。 */
export function toAnonymizationStats(stats: ScrubResult): AnonymizationResult["stats"] {
  return {
    totalEntities: stats.scrubbed,
    countsByType: stats.byType as AnonymizationResult["stats"]["countsByType"],
    modelVersion: "host-agnostic",
    policyVersion: "host-agnostic",
    processingTimeMs: 0,
  };
}