/**
 * Rehydra 扩展选项规范化（Pi 扩展使用）。
 *
 * - `normalizeRehydraOptions(raw)` —— 校验未知 / 畸形字段，落回默认值；
 * - `anonymizerConfigFromOptions(options, ctxDirectory)` —— 在 `anonymizer`
 *   与 `envFiles` 之间建立关联，给 `secrets.envBaseDirectory` 一个默认根；
 * - `policyFromOptions(options)` —— 处理 `disableTypes`，重新打开 secret 类型；
 * - `RehydraSharedOptions` —— 选项字段集合。
 */

import type { AnonymizerConfig } from "../core/anonymizer.js";
import {
  PIIType,
  SECRET_PII_TYPES,
  createDefaultPolicy,
} from "../types/index.js";
import type {
  AnonymizationPolicy,
  SecretsConfig,
  TagFormat,
} from "../types/index.js";

/** 字符串形式的 PII 类型名。 */
export type PIITypeName = `${PIIType}`;

export const DEFAULT_DISABLE_TYPES: PIITypeName[] = ["URL", "IP_ADDRESS"];
export const DEFAULT_ENV_FILES: string[] = ["**/.env*"];
export const DEFAULT_MIN_VALUE_LENGTH = 4;

/** Rehydra 共享的扩展选项结构。 */
export interface RehydraSharedOptions {
  envFiles?: string[];
  redactValues?: string[];
  minValueLength?: number;
  disableTypes?: PIITypeName[];
  vcsIdentities?: boolean;
  /** 允许这些工具的参数里出现无法还原的字面标签（默认空 = 一律阻断）。 */
  allowLiteralTagsIn?: string[];
  locale?: string;
  tagFormat?: TagFormat;
  policy?: Partial<AnonymizationPolicy>;
  /** `undefined` 表示用户没有显式配置；空对象 `{}` 也视为显式配置。 */
  anonymizer?: AnonymizerConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function asPIITypeNames(value: unknown): PIITypeName[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const known = new Set<string>(Object.values(PIIType));
  return value.filter(
    (item): item is PIITypeName => typeof item === "string" && known.has(item),
  );
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function asTagFormat(value: unknown): TagFormat | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.open !== "string" || typeof value.close !== "string") {
    return undefined;
  }
  const keyword = typeof value.keyword === "string" ? value.keyword : undefined;
  return { open: value.open, close: value.close, keyword };
}

function defaultSecretsConfig(options: RehydraSharedOptions): SecretsConfig {
  return {
    enabled: true,
    envFiles: options.envFiles ?? DEFAULT_ENV_FILES,
    redactValues: options.redactValues,
    minValueLength: options.minValueLength ?? DEFAULT_MIN_VALUE_LENGTH,
  };
}

/** 校验并规范化原始选项。未知字段一律忽略，畸形值落回默认值。 */
export function normalizeRehydraOptions(raw: unknown): RehydraSharedOptions {
  const source = isRecord(raw) ? raw : {};
  const normalized: RehydraSharedOptions = {
    envFiles: asStringArray(source.envFiles) ?? DEFAULT_ENV_FILES,
    redactValues: asStringArray(source.redactValues),
    minValueLength:
      asPositiveInteger(source.minValueLength) ?? DEFAULT_MIN_VALUE_LENGTH,
    disableTypes: asPIITypeNames(source.disableTypes) ?? DEFAULT_DISABLE_TYPES,
    vcsIdentities:
      typeof source.vcsIdentities === "boolean" ? source.vcsIdentities : false,
    allowLiteralTagsIn: asStringArray(source.allowLiteralTagsIn) ?? [],
    locale: typeof source.locale === "string" ? source.locale : undefined,
    tagFormat: asTagFormat(source.tagFormat),
  };

  if (isRecord(source.policy)) {
    normalized.policy = source.policy as Partial<AnonymizationPolicy>;
  }
  normalized.anonymizer = isRecord(source.anonymizer)
    ? (source.anonymizer as AnonymizerConfig)
    : undefined;

  return normalized;
}

/**
 * 把规范化的选项展开成 `AnonymizerConfig`。
 *
 * 优先级：
 * 1. 用户显式配置的 `anonymizer.secrets.envBaseDirectory`；
 * 2. 其余情况回退到 `ctxDirectory`（Pi 扩展传入当前 `cwd`）。
 */
export function anonymizerConfigFromOptions(
  options: RehydraSharedOptions,
  ctxDirectory: string,
): AnonymizerConfig {
  const userProvided = options.anonymizer !== undefined;
  const base: AnonymizerConfig = userProvided
    ? options.anonymizer!
    : { secrets: defaultSecretsConfig(options) };

  if (base.secrets === undefined) {
    return base;
  }

  const envBaseDirectory = base.secrets.envBaseDirectory ?? ctxDirectory;

  return {
    ...base,
    secrets: {
      ...base.secrets,
      envBaseDirectory,
    },
  };
}


/** 处理 `disableTypes` 并重新打开 secret 类型。 */
export function policyFromOptions(
  options: RehydraSharedOptions,
): Partial<AnonymizationPolicy> | undefined {
  const disableTypes = options.disableTypes ?? DEFAULT_DISABLE_TYPES;
  if (disableTypes.length === 0) {
    return options.policy;
  }

  const base = createDefaultPolicy();
  const disableSet = new Set<string>(disableTypes);
  const regexEnabledTypes = new Set(base.regexEnabledTypes);
  const nerEnabledTypes = new Set(base.nerEnabledTypes);
  for (const secretType of SECRET_PII_TYPES) {
    regexEnabledTypes.add(secretType);
  }
  for (const type of disableSet) {
    const piiType = type as PIIType;
    regexEnabledTypes.delete(piiType);
    nerEnabledTypes.delete(piiType);
  }

  return { ...options.policy, regexEnabledTypes, nerEnabledTypes };
}