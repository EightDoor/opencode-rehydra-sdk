/**
 * Tests for the V2 response rehydration layer (`http.response` /
 * `experimental.ws.receive`).
 *
 * The rehydrate callback is backed by a real `createAnonymizer` session so the
 * PII-tag → value lookup and tag format are exercised end to end.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createAnonymizer,
  InMemoryKeyProvider,
  InMemoryPIIStorageProvider,
  type AnonymizerSession,
} from "../../src/index.js";
import {
  InMemoryRehydrateTailStore,
  rehydrateHttpResponse,
  rehydrateWsFrame,
  type ResponseRehydrateDeps,
} from "../../src/opencode-plugin/v2/response-rehydrate.js";
import { createLogger } from "../../src/opencode-plugin/v2/logger.js";
import type { V2Logger } from "../../src/opencode-plugin/v2/types.js";

const TEST_SECRET = "sk-test";

const silentLogger: V2Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Creates a real anonymizer session that maps a value-derived PII tag back to
 * `TEST_SECRET`. The tag is produced by anonymizing the secret itself, so it
 * always matches the session's resolved tag format and PII map.
 */
async function makeSession(): Promise<{ session: AnonymizerSession; tag: string }> {
  const anonymizer = createAnonymizer({
    secrets: { enabled: true, redactValues: [TEST_SECRET] },
    keyProvider: new InMemoryKeyProvider(),
    piiStorageProvider: new InMemoryPIIStorageProvider(),
  });
  await anonymizer.initialize();

  const session = anonymizer.session("ses-response");
  const result = await session.anonymize(TEST_SECRET);
  const tagMatch = result.anonymizedText.match(/<PII[^>]*\/>/);
  if (tagMatch === null) {
    throw new Error(
      `expected the anonymous text to contain a PII tag: ${result.anonymizedText}`,
    );
  }
  return { session, tag: tagMatch[0]! };
}

function makeDeps(
  session: AnonymizerSession,
  overrides: Partial<ResponseRehydrateDeps> = {},
): ResponseRehydrateDeps {
  return {
    rehydrate: (input: string) => session.rehydrate(input),
    log: silentLogger,
    sessionID: "ses-response",
    kind: "primary",
    ...overrides,
  };
}

describe("rehydrateHttpResponse", () => {
  it("rehydrates PII tags in a JSON response body", async () => {
    const { session, tag } = await makeSession();
    const event = {
      response: new Response(
        JSON.stringify({ choices: [{ message: { content: `key=${tag}` } }] }),
        { headers: { "content-type": "application/json" } },
      ),
    };
    const original = event.response;

    await rehydrateHttpResponse(event, makeDeps(session));

    const body = (await event.response.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(body.choices[0]!.message.content).toBe(`key=${TEST_SECRET}`);
    expect(body.choices[0]!.message.content).not.toContain("<PII");
    expect(event.response).not.toBe(original);
  });

  it("rehydrates PII tags in an SSE response body and preserves frames", async () => {
    const { session, tag } = await makeSession();
    const sse = `event: message\nid: 1\ndata: {"chunk":"key=${tag}"}\n\ndata: [DONE]\n\n`;
    const event = {
      response: new Response(sse, {
        headers: { "content-type": "text/event-stream" },
      }),
    };

    await rehydrateHttpResponse(event, makeDeps(session));

    const text = await event.response.text();
    expect(text).toBe(
      `event: message\nid: 1\ndata: {"chunk":"key=${TEST_SECRET}"}\n\ndata: [DONE]\n\n`,
    );
    expect(text).not.toContain("<PII");
  });

  it("does not touch responses whose kind is not primary", async () => {
    const { session, tag } = await makeSession();
    const response = new Response(JSON.stringify({ content: tag }), {
      headers: { "content-type": "application/json" },
    });
    const event = { response };

    await rehydrateHttpResponse(event, makeDeps(session, { kind: "title" }));

    expect(event.response).toBe(response);
  });

  it("leaves the response untouched when rehydrate throws", async () => {
    const payload = JSON.stringify({
      content: '<PII type="ENV_VAR_SECRET" id="1"/>',
    });
    const response = new Response(payload, {
      headers: { "content-type": "application/json" },
    });
    const event = { response };
    const deps: ResponseRehydrateDeps = {
      rehydrate: async () => {
        throw new Error("boom");
      },
      log: silentLogger,
      sessionID: "ses-response",
      kind: "primary",
    };

    await expect(rehydrateHttpResponse(event, deps)).resolves.toBeUndefined();

    expect(event.response).toBe(response);
    expect(await event.response.text()).toBe(payload);
  });

  it("rehydrates an SSE response whose tag is split across stream chunks", async () => {
    const { session, tag } = await makeSession();
    const encoder = new TextEncoder();
    const full = `event: message\ndata: {"chunk":"key=${tag}"}\n\ndata: [DONE]\n\n`;
    const splitAt = full.indexOf(tag) + 3;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(full.slice(0, splitAt)));
        controller.enqueue(encoder.encode(full.slice(splitAt)));
        controller.close();
      },
    });
    const event = {
      response: new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      }),
    };

    await rehydrateHttpResponse(event, makeDeps(session));

    const text = await event.response.text();
    expect(text).toContain(`"key=${TEST_SECRET}"`);
    expect(text).not.toContain("<PII");
  });
});

describe("rehydrateWsFrame", () => {
  it("rehydrates a WebSocket frame in place", async () => {
    const { session, tag } = await makeSession();
    const event = { frame: `key=${tag}`, kind: "primary" as const };

    await rehydrateWsFrame(event, {
      rehydrate: (input: string) => session.rehydrate(input),
      log: silentLogger,
    });

    expect(event.frame).toBe(`key=${TEST_SECRET}`);
  });

  it("leaves the frame untouched when rehydrate throws", async () => {
    const frame = 'key=<PII type="ENV_VAR_SECRET" id="1"/>';
    const event = { frame, kind: "primary" as const };

    await rehydrateWsFrame(event, {
      rehydrate: async () => {
        throw new Error("boom");
      },
      log: silentLogger,
    });

    expect(event.frame).toBe(frame);
  });

  it("rehydrates a JSON WebSocket frame", async () => {
    const { session, tag } = await makeSession();
    const event = {
      frame: JSON.stringify({ delta: `key=${tag}` }),
      kind: "primary" as const,
    };

    await rehydrateWsFrame(event, {
      rehydrate: (input: string) => session.rehydrate(input),
      log: silentLogger,
      sessionID: "ses-ws-json",
      tailStore: new InMemoryRehydrateTailStore(),
    });

    expect(JSON.parse(event.frame)).toEqual({ delta: `key=${TEST_SECRET}` });
  });

  it("rehydrates a tag split across WebSocket frames", async () => {
    const { session, tag } = await makeSession();
    const store = new InMemoryRehydrateTailStore();
    const deps = {
      rehydrate: (input: string) => session.rehydrate(input),
      log: silentLogger,
      sessionID: "ses-ws-split",
      tailStore: store,
    };
    const full = `key=${tag} online`;
    const splitAt = full.indexOf(tag) + 2;
    const first = { frame: full.slice(0, splitAt), kind: "primary" as const };
    const second = { frame: full.slice(splitAt), kind: "primary" as const };

    await rehydrateWsFrame(first, deps);
    await rehydrateWsFrame(second, deps);

    expect(first.frame + second.frame).toBe(`key=${TEST_SECRET} online`);
  });

  it("rehydrates a tag split across JSON delta frames", async () => {
    const { session, tag } = await makeSession();
    const store = new InMemoryRehydrateTailStore();
    const deps = {
      rehydrate: (input: string) => session.rehydrate(input),
      log: silentLogger,
      sessionID: "ses-ws-delta",
      tailStore: store,
    };
    const head = tag.slice(0, 3);
    const rest = tag.slice(3);
    const first = {
      frame: JSON.stringify({
        choices: [{ delta: { content: `hello ${head}` } }],
      }),
      kind: "primary" as const,
    };
    const second = {
      frame: JSON.stringify({
        choices: [{ delta: { content: `${rest} world` } }],
      }),
      kind: "primary" as const,
    };

    await rehydrateWsFrame(first, deps);
    await rehydrateWsFrame(second, deps);

    const content = (frame: string): string => {
      const parsed = JSON.parse(frame) as {
        choices: { delta: { content: string } }[];
      };
      return parsed.choices[0]!.delta.content;
    };
    expect(content(first.frame) + content(second.frame)).toBe(
      `hello ${TEST_SECRET} world`,
    );
  });

  it("does not rehydrate non-primary frames and clears held fragments", async () => {
    const { session, tag } = await makeSession();
    const store = new InMemoryRehydrateTailStore();
    // Seed fragments as if an earlier primary frame had left them behind.
    store.set("ses-ws-kind", "<PI");
    store.setJsonTail("ses-ws-kind", "ws:/choices/0/delta/content", "<PI");

    const deps = {
      rehydrate: (input: string) => session.rehydrate(input),
      log: silentLogger,
      sessionID: "ses-ws-kind",
      tailStore: store,
    };

    for (const kind of ["title", "compaction", "generate"] as const) {
      const event = { frame: `key=${tag}`, kind };
      await rehydrateWsFrame(event, deps);
      expect(event.frame).toBe(`key=${tag}`);
    }

    expect(store.get("ses-ws-kind")).toBe("");
    expect(
      store.getJsonTail("ses-ws-kind", "ws:/choices/0/delta/content"),
    ).toBe("");
  });

  it("fails closed when the frame kind is absent", async () => {
    const { session, tag } = await makeSession();
    const event = { frame: `key=${tag}` };

    await rehydrateWsFrame(event, {
      rehydrate: (input: string) => session.rehydrate(input),
      log: silentLogger,
      sessionID: "ses-ws-nokind",
    });

    expect(event.frame).toBe(`key=${tag}`);
  });
});

describe("createLogger", () => {
  it("falls back to console when no client log sink exists", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = createLogger({});
      logger.error("boom", { code: 42 });
      logger.warn("careful");

      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]![0]).toBe(
        'service=rehydra level=error message=boom extra={"code":42}',
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe(
        "service=rehydra level=warn message=careful",
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
