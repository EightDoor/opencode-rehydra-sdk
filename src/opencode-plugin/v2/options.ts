/**
 * OpenCode plugin option normalization.
 *
 * OpenCode passes plugin options as untrusted, untyped data. These helpers
 * validate the shape against {@link RehydraPluginOptions}, drop unknown or
 * malformed fields, apply the plugin's documented defaults, and never throw.
 *
 * The resolved helpers mirror the behaviour of the original plugin:
 * - {@link anonymizerConfigFromOptions} defaults `secrets.envBaseDirectory` to
 *   the project directory.
 * - {@link policyFromOptions} keeps URL/IP_ADDRESS disabled by default while
 *   re-adding the opt-in secret types the anonymizer enables internally.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { AnonymizerConfig } from "../../core/anonymizer.js";
import {
  PIIType,
  SECRET_PII_TYPES,
  createDefaultPolicy,
} from "../../types/index.js";
import type { AnonymizationPolicy, SecretsConfig, TagFormat } from "../../types/index.js";
import type { PIITypeName, RehydraPluginOptions } from "../types.js";

const DEFAULT_DISABLE_TYPES: PIITypeName[] = ["URL", "IP_ADDRESS"];
const DEFAULT_ENV_FILES: string[] = ["**/.env*"];
const DEFAULT_MIN_VALUE_LENGTH = 4;

/**
 * Resolves the canonical OpenCode config directory (`$XDG_CONFIG_HOME/opencode`
 * or `$HOME/.config/opencode`). Returns `undefined` when no usable path can be
 * derived. Honours `XDG_CONFIG_HOME` on every platform so distros overriding
 * the spec keep working, and falls back to `~/.config/opencode` per the
 * OpenCode XDG spec.
 */
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
 * Heuristic: returns `true` when `projectDir` is somewhere underneath (or equal
 * to) `opencodeConfigDir`. Mirrors a directory-equality check rather than
 * relying on a separator-suffix workaround.
 */
export function shouldUseOpencodeConfigDir(
  projectDir: string,
  opencodeConfigDir: string,
): boolean {
  if (projectDir === opencodeConfigDir) return false;
  const withSep = opencodeConfigDir.replace(/[\/\\]+$/, "") + "/";
  const candidate = projectDir.replace(/[\/\\]+$/, "");
  return candidate.startsWith(withSep);
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

function defaultSecretsConfig(
  options: RehydraPluginOptions,
): SecretsConfig {
  return {
    enabled: true,
    envFiles: options.envFiles ?? DEFAULT_ENV_FILES,
    redactValues: options.redactValues,
    minValueLength: options.minValueLength ?? DEFAULT_MIN_VALUE_LENGTH,
  };
}

/**
 * Validates and normalizes raw OpenCode plugin options.
 *
 * Unknown or malformed fields are ignored and missing fields fall back to the
 * plugin defaults. When no `anonymizer` is supplied, one is derived from the
 * top-level secrets fields.
 *
 * @param raw - Untrusted options from OpenCode configuration.
 * @param ctxDirectory - Project directory, used as `secrets.envBaseDirectory`.
 */
export function normalizePluginOptions(
  raw: unknown,
  ctxDirectory: string,
): RehydraPluginOptions {
  const source = isRecord(raw) ? raw : {};
  const normalized: RehydraPluginOptions = {
    envFiles: asStringArray(source.envFiles) ?? DEFAULT_ENV_FILES,
    redactValues: asStringArray(source.redactValues),
    minValueLength:
      asPositiveInteger(source.minValueLength) ?? DEFAULT_MIN_VALUE_LENGTH,
    disableTypes: asPIITypeNames(source.disableTypes) ?? DEFAULT_DISABLE_TYPES,
    vcsIdentities:
      typeof source.vcsIdentities === "boolean" ? source.vcsIdentities : false,
    locale: typeof source.locale === "string" ? source.locale : undefined,
    tagFormat: asTagFormat(source.tagFormat),
  };

  if (isRecord(source.policy)) {
    normalized.policy = source.policy as Partial<AnonymizationPolicy>;
  }
  // Only forward `anonymizer` when the user actually configured one.
  // Leaving it `undefined` lets {@link anonymizerConfigFromOptions} distinguish
  // "user did not configure" from "user configured an empty block", which is
  // required to honour the global `~/.config/opencode` default for
  // `secrets.envBaseDirectory`.
  normalized.anonymizer = isRecord(source.anonymizer)
    ? (source.anonymizer as AnonymizerConfig)
    : undefined;

  return normalized;
}

/**
 * Resolves the anonymizer configuration.
 *
 * The base directory for `envFiles` paths is picked in this order:
 * 1. `anonymizer.secrets.envBaseDirectory` if the user configured it.
 * 2. The OpenCode config directory (`~/.config/opencode` on every supported
 *    platform) — when the user has not configured their own `anonymizer`
 *    block. This means a single `~/.config/opencode/.env` shared across all
 *    projects works without per-project paths, while project-local discovery
 *    stays opt-in by setting `secrets.envBaseDirectory` explicitly.
 *
 * 3. The project directory (final fallback).
 */
export function anonymizerConfigFromOptions(
  options: RehydraPluginOptions,
  ctxDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  homedirFn: () => string = homedir,
): AnonymizerConfig {
  const userProvided = options.anonymizer !== undefined;
  const base: AnonymizerConfig = userProvided
    ? options.anonymizer!
    : { secrets: defaultSecretsConfig(options) };

  if (base.secrets === undefined) {
    return base;
  }

  const envBaseDirectory = base.secrets.envBaseDirectory ?? (
    userProvided
      ? ctxDirectory
      : (opencodeConfigDirectory(env, homedirFn) ?? ctxDirectory)
  );

  return {
    ...base,
    secrets: {
      ...base.secrets,
      envBaseDirectory,
    },
  };
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
  const disableTypes = options.disableTypes ?? DEFAULT_DISABLE_TYPES;
  if (disableTypes.length === 0) {
    return options.policy;
  }

  const base = createDefaultPolicy();
  const disableSet = new Set<string>(disableTypes);
  const regexEnabledTypes = new Set(base.regexEnabledTypes);
  const nerEnabledTypes = new Set(base.nerEnabledTypes);
  // createDefaultPolicy() excludes secret types (opt-in via AnonymizerConfig
  // .secrets); add them back so this partial policy does not drop the secret
  // types the anonymizer registers internally.
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
