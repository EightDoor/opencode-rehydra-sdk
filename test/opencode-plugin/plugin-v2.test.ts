/**
 * Tests for the OpenCode Plugin V2 entry point shape.
 *
 * Verifies the default/named exports expose the V2 `{ id, setup }` contract,
 * that `setup` registers every expected hook, and that the returned cleanup
 * disposes every registration.
 */

import { describe, expect, it, vi } from "vitest";
import pluginDefault, {
  plugin as namedPlugin,
  createRehydraPlugin,
} from "../../src/opencode-plugin/plugin.js";
import * as barrel from "../../src/opencode-plugin/index.js";
import { Anonymizer } from "../../src/core/anonymizer.js";
import {
  createMockV2Context,
  sessionHandler,
} from "./v2-test-helpers.js";

const SESSION_HOOKS = [
  "compaction",
  "context",
  "experimental.ws.receive",
  "generate",
  "http.response",
  "title",
];

const TOOL_HOOKS = ["execute.after", "execute.before"];

describe("OpenCode Plugin V2 entry point", () => {
  it("exports a V2 plugin as the default export", () => {
    expect(pluginDefault.id).toBe("rehydra");
    expect(typeof pluginDefault.setup).toBe("function");
  });

  it("exports the same V2 plugin instance as the named export", () => {
    expect(namedPlugin).toBe(pluginDefault);
  });

  it("re-exports the default plugin and factory from the barrel entry", () => {
    expect(barrel.default).toBe(pluginDefault);
    expect(barrel.plugin).toBe(pluginDefault);
    expect(typeof barrel.createRehydraPlugin).toBe("function");
  });

  it("registers every expected hook on setup", async () => {
    const mock = createMockV2Context();

    await createRehydraPlugin().setup(mock.ctx);

    expect([...mock.sessionHooks.map((hook) => hook.name)].sort()).toEqual(
      [...SESSION_HOOKS].sort(),
    );
    expect([...mock.toolHooks.map((hook) => hook.name)].sort()).toEqual(
      [...TOOL_HOOKS].sort(),
    );
  });

  it("disposes every registration on cleanup", async () => {
    const mock = createMockV2Context();
    const cleanup = await createRehydraPlugin().setup(mock.ctx);

    expect(mock.disposed).toEqual([]);

    await cleanup!();

    expect([...mock.disposed].sort()).toEqual(
      [...SESSION_HOOKS, ...TOOL_HOOKS].sort(),
    );
  });

  it("continues setup when a hook registration fails", async () => {
    const registered: string[] = [];
    const disposed: string[] = [];
    const ctx = {
      options: undefined,
      location: { directory: "/test" },
      client: { app: { log: async () => {} } },
      session: {
        hook: async (name: string, _handler: unknown) => {
          if (name === "context") {
            throw new Error("hook unavailable");
          }
          registered.push(name);
          return {
            dispose: async () => {
              disposed.push(name);
            },
          };
        },
      },
      tool: {
        hook: async (name: string, _handler: unknown) => {
          registered.push(name);
          return {
            dispose: async () => {
              disposed.push(name);
            },
          };
        },
      },
    } as unknown as Parameters<typeof pluginDefault.setup>[0];

    const cleanup = await createRehydraPlugin().setup(ctx);

    expect(cleanup).toBeTypeOf("function");
    expect(registered).toContain("title");
    expect(registered).toContain("http.response");
    expect(registered).not.toContain("context");
    expect(registered).toContain("execute.before");

    await cleanup!();
    expect(disposed).toContain("title");
    expect(disposed).toContain("execute.before");
  });

  it("disposes the anonymizer on cleanup", async () => {
    const disposeSpy = vi
      .spyOn(Anonymizer.prototype, "dispose")
      .mockResolvedValue(undefined);
    try {
      const mock = createMockV2Context();
      const cleanup = await createRehydraPlugin().setup(mock.ctx);

      await cleanup!();

      expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      disposeSpy.mockRestore();
    }
  });

  it("routes scrubbing and rehydration through the hook event sessionID", async () => {
    const secret = "sk-proj-route123xyz789";
    const mock = createMockV2Context();
    await createRehydraPlugin({ redactValues: [secret] }).setup(mock.ctx);
    const context = sessionHandler(mock, "context");
    const httpResponse = sessionHandler(mock, "http.response");

    const parts = [{ type: "text", text: `key: ${secret}` }];
    // The message carries a stale sessionID; routing must follow the event.
    const staleMessage = {
      info: { sessionID: "ses-stale", role: "user" },
      parts,
    };
    await context({
      sessionID: "ses-live",
      system: [],
      messages: [staleMessage],
    });

    const tag = (parts[0] as { text: string }).text.match(/<PII[^/]*\/>/)?.[0];
    expect(tag).toBeDefined();

    const live = {
      sessionID: "ses-live",
      kind: "primary" as const,
      response: new Response(JSON.stringify({ content: `x ${tag}` }), {
        headers: { "content-type": "application/json" },
      }),
    };
    await httpResponse(live);
    expect(await live.response.text()).toContain(secret);

    const stale = {
      sessionID: "ses-stale",
      kind: "primary" as const,
      response: new Response(JSON.stringify({ content: `x ${tag}` }), {
        headers: { "content-type": "application/json" },
      }),
    };
    await httpResponse(stale);
    expect(await stale.response.text()).toContain("<PII");
  });

  it("does not rehydrate non-primary WebSocket frames", async () => {
    const secret = "sk-proj-ws123xyz789";
    const mock = createMockV2Context();
    await createRehydraPlugin({ redactValues: [secret] }).setup(mock.ctx);
    const context = sessionHandler(mock, "context");
    const ws = sessionHandler(mock, "experimental.ws.receive");

    const parts = [{ type: "text", text: `key: ${secret}` }];
    await context({
      sessionID: "ses-ws",
      system: [],
      messages: [{ info: { sessionID: "ses-ws" }, parts }],
    });
    const tag = (parts[0] as { text: string }).text.match(/<PII[^/]*\/>/)?.[0];
    expect(tag).toBeDefined();

    const titleEvent = { sessionID: "ses-ws", kind: "title", frame: `title ${tag}` };
    await ws(titleEvent);
    expect(titleEvent.frame).toContain("<PII");

    const primaryEvent = {
      sessionID: "ses-ws",
      kind: "primary",
      frame: `answer ${tag}`,
    };
    await ws(primaryEvent);
    expect(primaryEvent.frame).toContain(secret);
  });

  it("fails closed and leaves messages untouched when scrubbing throws", async () => {
    const secret = "sk-proj-failclosed123xyz";
    const mock = createMockV2Context();
    await createRehydraPlugin({ redactValues: [secret] }).setup(mock.ctx);
    const context = sessionHandler(mock, "context");

    const safeParts = [{ type: "text", text: `key ${secret}` }];
    const poisoned = {
      info: { sessionID: "ses-fail", role: "user" },
      get parts(): unknown {
        throw new Error("clone fail");
      },
    };
    const messages = [
      { info: { sessionID: "ses-fail", role: "user" }, parts: safeParts },
      poisoned,
    ];

    await expect(
      context({ sessionID: "ses-fail", system: [], messages }),
    ).rejects.toThrow("clone fail");

    // The whole pass aborted before any write-back: no partial scrubbing.
    expect(safeParts[0]!.text).toBe(`key ${secret}`);
  });
});
