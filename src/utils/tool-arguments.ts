/**
 * 工具执行前的严格参数还原。
 *
 * 与通用 `session.rehydrate()` 的宽松语义相反：
 * - 先在副本上完成全部字符串的还原与校验，全部成功后才写回宿主入参；
 * - 任何无法解析的占位符（映射缺失、解密失败、未知或残缺标签）都中止调用，
 *   绝不把 `<PII .../>` 当真实值传给命令或写进文件；
 * - 错误只带原因码与参数路径，路径中的键名也做白名单收敛，不含真实值。
 *
 * 这是"占位符泄漏到执行链路"的唯一修复点，Pi / OpenCode / Proxy 三个宿主共用。
 */
import type { AnonymizerSessionImpl } from "../storage/session-base.js";
import { extractTags } from "../pipeline/tagger.js";
import { escapeRegExp } from "../utils/regex.js";
import type { TagFormat } from "../types/index.js";

/** 阻断原因码；只描述类别，不含参数正文。 */
export type ToolArgumentFailureCode =
  | "unresolved-tag"
  | "missing-pii-map"
  | "decrypt-failed"
  | "rehydrate-failed";

/** 工具参数还原失败；宿主应据此中止该次工具调用。 */
export class ToolArgumentRehydrateError extends Error {
  readonly code: ToolArgumentFailureCode;
  /** 出错参数的位置（如 `$.command`），键名已收敛，不含参数正文。 */
  readonly path: string;

  constructor(code: ToolArgumentFailureCode, path: string) {
    super(`tool arguments contain unresolved PII placeholders (${code}) at ${path}`);
    this.name = "ToolArgumentRehydrateError";
    this.code = code;
    this.path = path;
  }
}

export interface StrictRehydrateOptions {
  /** 识别标签用的格式，须与匿名器实际输出一致；解析按该格式的 fuzzy 规则走。 */
  readonly tagFormat: TagFormat;
  /**
   * 无法还原的标签是否放行（默认 false = 阻断）。
   *
   * 供 write / edit 这类"参数正文里本来就可能出现标签示例"的工具显式放开：
   * 还原失败（无映射 / 解密失败）或标签解析不出来时都原样保留；能还原的照常还原。
   */
  readonly allowUnresolved?: boolean;
  /** 放行一个无法还原的标签时回调；只带参数路径，不含正文。 */
  readonly onUnresolvedTag?: (path: string) => void;
}

/**
 * 就地还原工具入参中的 PII 标签，失败即抛出 {@link ToolArgumentRehydrateError}。
 *
 * 返回还原后的值：对象与数组在原引用上改写（宿主持有该引用），根为字符串时
 * 通过返回值给出结果。
 */
export async function rehydrateToolArgumentsInPlace(
  value: unknown,
  session: AnonymizerSessionImpl,
  options: StrictRehydrateOptions,
): Promise<unknown> {
  const ctx: StrictContext = {
    ...createStrictContext(options.tagFormat),
    allowUnresolved: options.allowUnresolved === true,
    onUnresolvedTag: options.onUnresolvedTag,
  };
  const restored = await restoreValue(value, session, ctx, "$");
  return writeBack(value, restored);
}

/** 判定字符串是否是标签的上下文；正则按格式构建一次，避免每段字符串重编译。 */
interface StrictContext {
  readonly tagFormat: TagFormat;
  /** 开标签前缀（如 `<PII` / `< PII` / `&lt;PII`，忽略大小写），用于兜住残标签。 */
  readonly openTagRe: RegExp;
  readonly allowUnresolved: boolean;
  readonly onUnresolvedTag?: (path: string) => void;
}

function createStrictContext(
  tagFormat: TagFormat,
): Pick<StrictContext, "tagFormat" | "openTagRe"> {
  const keyword = tagFormat.keyword ?? "PII";
  const open = tagFormat.open === "<" ? "(?:<|&lt;)" : escapeRegExp(tagFormat.open);
  return {
    tagFormat,
    openTagRe: new RegExp(`${open}\\s*${escapeRegExp(keyword)}`, "i"),
  };
}

/**
 * 是否像标签：先用与 `rehydrate()` 同一套 fuzzy 解析器判断（覆盖大小写、空白与
 * HTML 实体变体），再用开标签前缀兜底被截断的残标签。只看精确前缀会漏掉
 * `<pii …/>` 这类可还原标签，也会漏掉 `<PII type="EMAIL" id="` 这类残缺标签。
 */
function looksLikeTag(text: string, ctx: StrictContext): boolean {
  return extractTags(text, ctx.tagFormat).length > 0 || ctx.openTagRe.test(text);
}

async function restoreValue(
  value: unknown,
  session: AnonymizerSessionImpl,
  ctx: StrictContext,
  path: string,
): Promise<unknown> {
  if (typeof value === "string") {
    if (!looksLikeTag(value, ctx)) return value;
    const restored = await rehydrateString(value, session, ctx, path);
    // 还原后仍像标签 = 映射里没有的未知/残缺标签：默认阻断；
    // 工具被显式放开（allowUnresolved）时原样保留，而不是把标签当真实值执行。
    if (looksLikeTag(restored, ctx)) {
      if (ctx.allowUnresolved) {
        ctx.onUnresolvedTag?.(path);
        return restored;
      }
      throw new ToolArgumentRehydrateError("unresolved-tag", path);
    }
    return restored;
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      out.push(await restoreValue(value[i], session, ctx, `${path}[${i}]`));
    }
    return out;
  }

  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const keyPath = `${path}.${safePathKey(key)}`;
      setOwn(out, key, await restoreValue(source[key], session, ctx, keyPath));
    }
    return out;
  }

  return value;
}

async function rehydrateString(
  text: string,
  session: AnonymizerSessionImpl,
  ctx: StrictContext,
  path: string,
): Promise<string> {
  try {
    return await session.rehydrate(text);
  } catch (error) {
    // 放行的工具里，会话出错（无映射 / 解密失败）等同于"没有可还原的值"。
    if (ctx.allowUnresolved) {
      ctx.onUnresolvedTag?.(path);
      return text;
    }
    throw new ToolArgumentRehydrateError(classifyFailure(error), path);
  }
}

/** 会话层错误只映射成原因码；原始 message 可能含路径或会话信息，不外传。 */
function classifyFailure(error: unknown): ToolArgumentFailureCode {
  // WebCrypto 的 AES-GCM 解密失败是 OperationError，message 里通常没有 "decrypt"。
  if (error instanceof Error && error.name === "OperationError") return "decrypt-failed";
  const message = error instanceof Error ? error.message : "";
  if (message.includes("No PII map found")) return "missing-pii-map";
  if (message.includes("decrypt")) return "decrypt-failed";
  return "rehydrate-failed";
}

/**
 * 错误路径可能被写进宿主日志，所以只保留安全形状的键名；键名本身就可能是 PII
 * （例如以邮箱为键的参数），其余一律折叠成 `<key>`。
 */
function safePathKey(key: string): string {
  return /^[A-Za-z0-9_.-]{1,40}$/.test(key) ? key : "<key>";
}

/**
 * `obj["__proto__"] = v` 会改原型而不是建自有键，副本与写回都必须显式定义自有属性，
 * 否则该键上的标签会绕过还原直接进入工具。
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  target[key] = value;
}

/** 把已全部还原成功的副本写回原值；形状由 {@link restoreValue} 保证一致。 */
function writeBack(target: unknown, source: unknown): unknown {
  if (Array.isArray(source) && Array.isArray(target)) {
    const original = target as unknown[];
    const restored = source as unknown[];
    for (let i = 0; i < restored.length; i++) {
      original[i] = writeBack(original[i], restored[i]);
    }
    return original;
  }

  if (
    source !== null &&
    typeof source === "object" &&
    !Array.isArray(source) &&
    target !== null &&
    typeof target === "object" &&
    !Array.isArray(target)
  ) {
    const original = target as Record<string, unknown>;
    const restored = source as Record<string, unknown>;
    for (const key of Object.keys(restored)) {
      setOwn(original, key, writeBack(original[key], restored[key]));
    }
    return original;
  }

  return source;
}
