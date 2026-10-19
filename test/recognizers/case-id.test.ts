/**
 * 通用 CASE_ID 规则回归测试。
 *
 * 背景：原规则 `(?:CASE|FILE|REF|TICKET)[\s-]?[A-Z0-9]{4,12}` 大小写不敏感且编号
 * 允许纯字母，导致 `case CodeUnauthorized:` 这类源码被替换成占位符并写进文件。
 * 现在要求显式分隔符 + 编号含数字；纯字母与紧连格式需要自定义规则。
 */
import { describe, it, expect } from "vitest";

import {
  COMMON_ID_PATTERNS,
  createCaseIdRecognizer,
  createCustomIdRecognizer,
} from "../../src/recognizers/custom-id.js";

const recognizer = createCaseIdRecognizer();

function hits(text: string): string[] {
  return recognizer.find(text).map((m) => text.slice(m.start, m.end));
}

describe("generic CASE_ID recognizer", () => {
  it("leaves Go switch cases and identifiers alone", () => {
    const source = [
      "switch code {",
      "\tcase CodeUnauthorized || code == CodeTokenExpired:",
      "\t\treturn http.StatusUnauthorized",
      "}",
    ].join("\n");

    expect(hits(source)).toEqual([]);
  });

  it("leaves identifiers, fields and module paths alone", () => {
    expect(hits("fileRef = 123; files = 2; tickets = 0;")).toEqual([]);
    expect(hits("cd gateway && go get gopkg.in/yaml.v3@latest")).toEqual([]);
    expect(hits("cd gateway && go get github.com/foo/bar/v3@latest")).toEqual([]);
  });

  /**
   * 关键回归：真正被旧规则误伤的是"短标识符"（≤12 位）与紧连/纯字母编号，
   * 例如 Go 源码里的 `case CapPower:` 会连同 `case ` 被替换成占位符。
   * 长标识符（`CodeUnauthorized`，16 位）超过旧的 12 位上限本就不命中，
   * 不能拿它们当回归证据，因此这里用片段拼接写清每个样本的真实内容。
   */
  it("stops matching what the loose pattern used to replace", () => {
    const OLD = /\b(?:CASE|FILE|REF|TICKET)[\s-]?[A-Z0-9]{4,12}\b/gi;
    const usedToMatch = [
      "case " + "Cap" + "Power" + ":", // Go switch 分支里的短标识符
      "ref " + "Data" + ":",
      "CASE" + "123456", // 紧连前缀
      "TICKET" + "ABCDEF", // 纯字母编号
    ];

    for (const text of usedToMatch) {
      OLD.lastIndex = 0;
      expect(OLD.test(text), `旧规则应命中：${text}`).toBe(true);
      expect(hits(text), `新规则不应命中：${text}`).toEqual([]);
    }
  });

  it("still detects explicitly separated ids that contain digits", () => {
    expect(hits("Case 123456 is open")).toEqual(["Case 123456"]);
    expect(hits("TICKET-98765 assigned")).toEqual(["TICKET-98765"]);
    expect(hits("REF 12AB34 closed")).toEqual(["REF 12AB34"]);
  });

  it("does not detect letters-only or glue-on ids without a custom rule", () => {
    expect(hits("reference ABCDEFGH")).toEqual([]);
    expect(hits("case123456")).toEqual([]);
  });

  it("does not match across a line break", () => {
    expect(hits("case\n123456")).toEqual([]);
  });

  it("exposes the tightened pattern as the shared template", () => {
    expect(COMMON_ID_PATTERNS["genericCaseNumber"]!.source).toContain("[ \\t-]");
  });

  it("keeps caller-provided patterns in charge of their own shape", () => {
    const custom = createCustomIdRecognizer([
      {
        name: "Glue-on case id",
        pattern: /\bCASE[0-9]{4,12}\b/g,
        type: "CASE_ID" as never,
      },
    ]);

    const text = "case123456 vs CASE123456";
    expect(custom.find(text).map((m) => text.slice(m.start, m.end))).toEqual([
      "CASE123456",
    ]);
  });
});
