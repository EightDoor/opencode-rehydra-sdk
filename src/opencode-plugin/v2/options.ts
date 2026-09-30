/**
 * OpenCode 插件专用选项适配层。
 *
 * 真正的归一化、policy 合并、`anonymizerConfig` 装配都委托给宿主无关的
 * {@link normalizeRehydraOptions} / {@link anonymizerConfigFromOptions} /
 * {@link policyFromOptions}；本文件仅负责：
 *
 * - 把 OpenCode 传入的原始 options 投影成宿主无关的 `RehydraSharedOptions`；
 * - 在用户未配置 `anonymizer` 时使用 OpenCode 的全局配置目录作为 envFiles 根；
 * - 暴露 OpenCode 特有的 `opencodeConfigDirectory` 工具函数给测试与外部调用方。
 */
import { homedir } from "node:os";
import { join } from "node:path";

import type { AnonymizerConfig } from "../../core/anonymizer.js";
import type { RehydraSharedOptions } from "../../host-agnostic/normalize-options.js";
import {
  anonymizerConfigFromOptions as sharedAnonymizerConfig,
  normalizeRehydraOptions as sharedNormalize,
  policyFromOptions as sharedPolicyFromOptions,
} from "../../host-agnostic/normalize-options.js";
import type {
  AnonymizationPolicy,
} from "../../types/index.js";
import type { PIITypeName, RehydraPluginOptions } from "../types.js";

export type { PIITypeName };

/**
 * OpenCode-specific: 把 OpenCode plugin 的 `RehydraPluginOptions` 类型当作
 * 宿主无关 `RehydraSharedOptions` 的子集。两者结构完全一致；类型别名让
 * normalize 模块不依赖 OpenCode plugin 内部类型。
 */
export type OpencodeNormalizedOptions = RehydraSharedOptions;

/** OpenCode 视角的 options 规范化：透传到共享层。 */
export function normalizePluginOptions(
  raw: unknown,
  // `ctxDirectory` 在 OpenCode 这里保留是为了与旧 API 一致；本实现不依赖它。
  _ctxDirectory: string,
): RehydraPluginOptions {
  const shared = sharedNormalize(raw);
  return shared as unknown as RehydraPluginOptions;
}

/** 把 OpenCode 的全局配置目录暴露给共享层。 */
export function opencodeConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homedirFn: () => string = homedir,
): string | undefined {
  const xdg = env.XDG_CONFIG_HOME;
  if (typeof xdg === "string" && xdg.trim().length > 0) {
    return join(xdg, "opencode");
  }
  const candidates = [env.HOME, env.USERPROFILE, homedirFn()];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return join(candidate, ".config", "opencode");
    }
  }
  return undefined;
}

/**
 * 装配 `AnonymizerConfig`：未显式配置 `anonymizer` 时使用
 * `~/.config/opencode` 作为 envFiles 根。
 */
export function anonymizerConfigFromOptions(
  options: RehydraPluginOptions,
  ctxDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  homedirFn: () => string = homedir,
): AnonymizerConfig {
  return sharedAnonymizerConfig(
    options as unknown as RehydraSharedOptions,
    ctxDirectory,
    opencodeConfigDirectory(env, homedirFn),
    env,
    homedirFn,
  );
}

/**
 * Builds the policy override implied by `disableTypes`.
 *
 * Returns `options.policy` unchanged when nothing is disabled (or the caller
 * explicitly disabled nothing), matching the original plugin behaviour.
 */
export function policyFromOptions(
  options: RehydraPluginOptions,
): Partial<AnonymizationPolicy> | undefined {
  return sharedPolicyFromOptions(options as unknown as RehydraSharedOptions);
}

/**
 * `shouldUseOpencodeConfigDir` 保留作内部兼容测试用：判断项目目录是否
 * 在 OpenCode 全局配置目录之下。
 */
export function shouldUseOpencodeConfigDir(
  projectDir: string,
  opencodeConfigDir: string,
): boolean {
  if (projectDir === opencodeConfigDir) return false;
  const withSep = opencodeConfigDir.replace(/[/\\]+$/, "") + "/";
  const candidate = projectDir.replace(/[/\\]+$/, "");
  return candidate.startsWith(withSep);
}