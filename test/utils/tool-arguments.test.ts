/**
 * 工具参数严格还原测试。
 *
 * 关键契约：还原不全必须阻断，阻断时不得留下"部分已还原"的入参，
 * 且标签判定要覆盖 rehydrate() 支持的 fuzzy 变体（大小写、空白、HTML 实体）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createAnonymizer, type Anonymizer } from "../../src/index.js";
import { InMemoryKeyProvider } from "../../src/crypto/index.js";
import { InMemoryPIIStorageProvider } from "../../src/storage/in-memory.js";
import type { AnonymizerSessionImpl } from "../../src/storage/session.js";
import {
  ToolArgumentRehydrateError,
  rehydrateToolArgumentsInPlace,
} from "../../src/utils/tool-arguments.js";
import { buildTagPrefix } from "../../src/utils/regex.js";
import { DEFAULT_TAG_FORMAT } from "../../src/types/index.js";

const TAG_PREFIX = buildTagPrefix(DEFAULT_TAG_FORMAT);
const OPTIONS = { tagFormat: DEFAULT_TAG_FORMAT };
const SECRET = "alice.leak@example.com";

let anonymizer: Anonymizer;

function makeSession(sessionId: string): AnonymizerSessionImpl {
  return anonymizer.session(sessionId) as unknown as AnonymizerSessionImpl;
}

/** 先脱敏一段文本并取回 `<PII .../>` 标签，让该会话拥有可用映射。 */
async function makeTag(sessionId: string): Promise<{ tag: string; session: AnonymizerSessionImpl }> {
  const target = makeSession(sessionId);
  const result = await target.anonymize(`contact ${SECRET} now`);
  const tag = result.anonymizedText.match(/<PII[^/]*\/>/)![0]!;
  return { tag, session: target };
}

function expectBlocked(error: unknown): ToolArgumentRehydrateError {
  expect(error).toBeInstanceOf(ToolArgumentRehydrateError);
  return error as ToolArgumentRehydrateError;
}

describe("rehydrateToolArgumentsInPlace", () => {
  beforeEach(async () => {
    anonymizer = createAnonymizer({
      ner: { mode: "disabled" },
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: new InMemoryPIIStorageProvider(),
    });
    await anonymizer.initialize();
  });

  afterEach(async () => {
    await anonymizer.dispose();
  });

  it("restores tags in nested args in place", async () => {
    const { tag, session } = await makeTag("nested");
    const input: Record<string, unknown> = {
      command: `go get ${tag} 2>&1 | tail -2`,
      nested: { list: [`item-${tag}`] },
    };

    const result = await rehydrateToolArgumentsInPlace(input, session, OPTIONS);

    // 宿主持有原引用，必须就地改写而不是替换根对象。
    expect(result).toBe(input);
    expect(input["command"]).toContain(SECRET);
    expect((input["nested"] as { list: string[] }).list[0]).toContain(SECRET);
    expect(JSON.stringify(input)).not.toContain(TAG_PREFIX);
  });

  it("restores fuzzy tag variants that rehydrate() itself accepts", async () => {
    const { tag, session } = await makeTag("fuzzy");
    const id = tag.match(/id="([^"]+)"/)![1]!;
    const variants = [
      `<pii type="EMAIL" id="${id}"/>`,
      `< PII type="EMAIL" id="${id}" />`,
      `&lt;PII type="EMAIL" id="${id}"/&gt;`,
    ];

    for (const variant of variants) {
      const input = { command: `curl ${variant}` };
      await rehydrateToolArgumentsInPlace(input, session, OPTIONS);
      expect(input["command"]).toContain(SECRET);
      expect(input["command"]).not.toContain("type=");
    }
  });

  it("blocks a fuzzy variant whose id is not in the map", async () => {
    const { session } = await makeTag("fuzzy-unknown");
    const input = { command: 'curl <pii type="EMAIL" id="999999"/>' };

    const error = expectBlocked(
      await rehydrateToolArgumentsInPlace(input, session, OPTIONS).catch((err: unknown) => err),
    );

    expect(error.code).toBe("unresolved-tag");
    expect(input["command"]).toContain("999999");
  });

  it("keeps args without tags untouched, even with no PII map", async () => {
    // 该会话从未脱敏过：没有标签就不该要求映射存在。
    const session = makeSession("untouched");
    const input = { command: "ls -la", path: "/home/user", count: 3 };

    await expect(rehydrateToolArgumentsInPlace(input, session, OPTIONS)).resolves.toBe(input);
    expect(input).toEqual({ command: "ls -la", path: "/home/user", count: 3 });
  });

  it("blocks an unknown tag id and leaves every arg untouched", async () => {
    const { tag, session } = await makeTag("unknown-id");
    const unknown = tag.replace(/id="[^"]+"/, 'id="999999"');
    const input = { command: `curl ${tag}`, other: unknown };

    const error = expectBlocked(
      await rehydrateToolArgumentsInPlace(input, session, OPTIONS).catch((err: unknown) => err),
    );

    expect(error.code).toBe("unresolved-tag");
    expect(error.path).toBe("$.other");
    // 第二个参数失败 → 第一个参数也不能被改写（无部分写回）。
    expect(input["command"]).toBe(`curl ${tag}`);
  });

  it("restores a tagged value stored under an own __proto__ key", async () => {
    const { tag, session } = await makeTag("proto");
    // JSON.parse 会产生自有 __proto__ 键；副本若用普通对象赋值会丢掉它。
    // 标签里含引号，需按 JSON 规则转义后再拼进字面量。
    const escaped = JSON.stringify(tag).slice(1, -1);
    const input = JSON.parse(`{"__proto__":"x ${escaped}","ok":"${escaped}"}`) as Record<
      string,
      unknown
    >;

    await rehydrateToolArgumentsInPlace(input, session, OPTIONS);

    const own = Object.getOwnPropertyDescriptor(input, "__proto__")?.value as string;
    expect(own).toContain(SECRET);
    expect(input["ok"]).toContain(SECRET);
    expect(JSON.stringify(Object.getOwnPropertyNames(input))).not.toContain(TAG_PREFIX);
  });

  describe("allowUnresolved（显式放行字面标签）", () => {
    it("keeps the literal tag instead of throwing, and reports the path", async () => {
      const { session } = await makeTag("allow");
      const input = { content: '# doc\n\nplaceholder: <PII type="PERSON" id="999999"/>' };
      const seen: string[] = [];

      await rehydrateToolArgumentsInPlace(input, session, {
        ...OPTIONS,
        allowUnresolved: true,
        onUnresolvedTag: (path) => seen.push(path),
      });

      expect(input["content"]).toContain("<PII");
      expect(seen).toEqual(["$.content"]);
    });

    it("still restores the tags it can resolve", async () => {
      const { tag, session } = await makeTag("allow-mixed");
      const input = {
        content: `real: ${tag} unknown: <PII type="PERSON" id="999999"/>`,
      };
      const seen: string[] = [];

      await rehydrateToolArgumentsInPlace(input, session, {
        ...OPTIONS,
        allowUnresolved: true,
        onUnresolvedTag: (path) => seen.push(path),
      });

      expect(input["content"]).toContain(SECRET);
      expect(input["content"]).toContain('<PII type="PERSON"');
      expect(seen).toEqual(["$.content"]);
    });

    it("is off by default", async () => {
      const { session } = await makeTag("allow-off");
      const input = { content: '<PII type="PERSON" id="999999"/>' };

      const error = expectBlocked(
        await rehydrateToolArgumentsInPlace(input, session, OPTIONS).catch(
          (err: unknown) => err,
        ),
      );

      expect(error.code).toBe("unresolved-tag");
    });
  });

  it("blocks when the session has no PII map", async () => {
    const session = makeSession("no-map");
    const input = { command: `curl ${"<PII type=\"EMAIL\" id=\"1\"/>"}` };

    const error = expectBlocked(
      await rehydrateToolArgumentsInPlace(input, session, OPTIONS).catch((err: unknown) => err),
    );

    expect(error.code).toBe("missing-pii-map");
  });

  it("blocks a partial tag and reports the failing path", async () => {
    const { session } = await makeTag("partial");
    const input = { nested: { list: ["ok", "value <PII type=\"EMAIL\" id=\""] } };

    const error = expectBlocked(
      await rehydrateToolArgumentsInPlace(input, session, OPTIONS).catch((err: unknown) => err),
    );

    expect(error.code).toBe("unresolved-tag");
    expect(error.path).toBe("$.nested.list[1]");
  });

  it("reports decrypt failures as decrypt-failed", async () => {
    const storage = new InMemoryPIIStorageProvider();
    const first = createAnonymizer({
      ner: { mode: "disabled" },
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: storage,
    });
    await first.initialize();
    const encrypted = await first.session("rotated").anonymize(`contact ${SECRET} now`);
    const tag = encrypted.anonymizedText.match(/<PII[^/]*\/>/)![0]!;

    // 同一存储、不同密钥：WebCrypto 会抛 OperationError（message 里不含 decrypt）。
    const second = createAnonymizer({
      ner: { mode: "disabled" },
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: storage,
    });
    await second.initialize();

    const error = expectBlocked(
      await rehydrateToolArgumentsInPlace({ command: `curl ${tag}` }, second.session("rotated") as never, OPTIONS).catch(
        (err: unknown) => err,
      ),
    );

    expect(error.code).toBe("decrypt-failed");
    await first.dispose();
    await second.dispose();
  });

  it("never leaks argument text, values or sensitive keys into the error", async () => {
    const { tag, session } = await makeTag("no-leak");
    const emailKey = "a" + "lice" + "@" + "exa" + "mple" + ".com";
    const bad = {
      command: `export TOKEN=${tag.replace(/id="[^"]+"/, 'id="42"')} secret-arg-xyz`,
      nested: { [emailKey]: tag.replace(/id="[^"]+"/, 'id="43"') },
    };

    const error = expectBlocked(
      await rehydrateToolArgumentsInPlace(bad, session, OPTIONS).catch((err: unknown) => err),
    );

    expect(error.message).not.toContain("secret-arg-xyz");
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(emailKey);
    expect(error.message).toContain("$.command");
  });

  it("cannot restore a tag that is absent from this session's map", async () => {
    const { tag } = await makeTag("session-a");
    const other = makeSession("session-b");
    // session-b 有自己的映射（URL），但没有 EMAIL 标签，确保走"标签不存在"
    // 分支而不是"没有映射"分支。
    await other.anonymize("see https://example.com/docs for details");

    const input = { command: `go get ${tag}` };
    const error = expectBlocked(
      await rehydrateToolArgumentsInPlace(input, other, OPTIONS).catch((err: unknown) => err),
    );

    expect(error.code).toBe("unresolved-tag");
    expect(input["command"]).toBe(`go get ${tag}`);
  });
});
