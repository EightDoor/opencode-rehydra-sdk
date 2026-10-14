/**
 * 共享选项规范化测试（Pi 扩展路径）。
 *
 * 重点锁住 envBaseDirectory 的回退：未显式配置时必须落在 ctxDirectory（cwd），
 * 不再回退到任何宿主专属配置目录。
 */
import { describe, expect, it } from "vitest";

import {
  anonymizerConfigFromOptions,
  normalizeRehydraOptions,
} from "../../src/host-agnostic/normalize-options.js";

describe("anonymizerConfigFromOptions", () => {
  it("falls back to ctxDirectory (cwd) as the envFiles root", () => {
    const options = normalizeRehydraOptions({ envFiles: [".env"] });
    const config = anonymizerConfigFromOptions(options, "/project");
    expect(config.secrets?.envBaseDirectory).toBe("/project");
  });

  it("preserves an explicit secrets.envBaseDirectory", () => {
    const options = normalizeRehydraOptions({
      anonymizer: { secrets: { envBaseDirectory: "/custom" } },
    });
    const config = anonymizerConfigFromOptions(options, "/project");
    expect(config.secrets?.envBaseDirectory).toBe("/custom");
  });
});

describe("normalizeRehydraOptions", () => {
  it("ignores unknown fields and falls back malformed values to defaults", () => {
    const options = normalizeRehydraOptions({
      unknownField: 1,
      minValueLength: -3,
      envFiles: "not-an-array",
    });
    expect(options.minValueLength).toBe(4);
    expect(options.envFiles).toEqual(["**/.env*"]);
    expect("unknownField" in options).toBe(false);
  });
});
