/**
 * Pi extension 配置类型。
 *
 * 与 OpenCode plugin 保持对齐，但去掉只在 OpenCode V2 hook 上下文存在的字段：
 * - 不需要 `envBaseDirectory`（Pi 扩展以当前 `cwd` 为根）。
 * - 不需要 `anonymizer` 全量覆盖，扩展内部统一构建。
 *
 * 字段在 Pi 包的 `settings.json` `extensions` 配置中作为 `options.envFiles` 等
 * 传入；扩展本身只读取，不写。
 */
import type { AnonymizerConfig } from "../core/anonymizer.js";
import type {
  AnonymizationPolicy,
  TagFormat,
} from "../types/index.js";
import type { PIIType } from "../types/pii-types.js";

/** 与 OpenCode plugin 一致的 PII 类型字符串名集合。 */
export type PIITypeName = `${PIIType}`;

export interface RehydraPiExtensionOptions {
  /** Paths/globs relative to the Pi project directory (cwd). Defaults to recursive .env discovery. */
  envFiles?: string[];

  /** Explicit values to always redact. */
  redactValues?: string[];

  /** Minimum value length to consider a secret (default: 4). */
  minValueLength?: number;

  /** PII types to disable (default: ["URL", "IP_ADDRESS"]). Pass [] to enable all types. */
  disableTypes?: PIITypeName[];

  /** Locale hint for anonymization. */
  locale?: string;

  /** Redact identities found in Git and GitHub CLI output. */
  vcsIdentities?: boolean;

  /** Policy overrides applied to every scrub pass. */
  policy?: Partial<AnonymizationPolicy>;

  /** Advanced: full anonymizer config (overrides envFiles/redactValues/minValueLength). */
  anonymizer?: AnonymizerConfig;

  /** Tag format configuration. */
  tagFormat?: TagFormat;
}