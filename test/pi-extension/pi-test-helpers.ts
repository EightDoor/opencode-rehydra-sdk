/**
 * 模拟 Pi 的 ExtensionAPI 形态，便于在 vitest 里直接调用扩展钩子。
 *
 * 实际上是把 ExtensionAPI 上每个 `on(name, handler)` 调用记录到 handlers 列表，
 * 并把 `registerCommand` / `getSettings` 的常见调用桩起来。
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "../../src/pi-extension/host-types.js";

type AnyHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface RecordedHandler {
  name: string;
  handler: AnyHandler;
}

export interface MockPiContext {
  ctx: ExtensionContext;
  api: ExtensionAPI;
  handlers: RecordedHandler[];
  sessionId: string;
  cwd: string;
}

export interface MockPiOptions {
  sessionId?: string;
  cwd?: string;
  redactValues?: string[];
  envFiles?: string[];
}

/**
 * 构造一个最小的 ExtensionAPI + ExtensionContext，捕获所有事件钩子。
 */
export function createMockPiContext(options: MockPiOptions = {}): MockPiContext {
  const sessionId = options.sessionId ?? "ses-pi";
  const cwd = options.cwd ?? "C:/tmp/pi-mock";
  const handlers: RecordedHandler[] = [];

  // 简化版的 SessionManager 桩：仅暴露 getSessionId / getCwd。
  const sessionManager = {
    getSessionId: () => sessionId,
    getCwd: () => cwd,
  };

  // 简化版的 UI 桩：notify / select / custom 都是 noop。
  const ui = {
    notify: () => undefined,
    select: async () => undefined,
    custom: async () => undefined,
  };

  const ctx = {
    ui,
    mode: "tui" as const,
    hasUI: true,
    cwd,
    sessionManager,
    model: undefined,
    scopedModels: [],
    thinkingLevel: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
  } as unknown as ExtensionContext;

  const api = {
    on(name: string, handler: AnyHandler) {
      handlers.push({ name, handler });
      return () => {
        const idx = handlers.findIndex((h) => h.name === name && h.handler === handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    registerCommand: () => undefined,
    getSettings: () => {
      const settings: Record<string, unknown> = {};
      if (options.redactValues !== undefined || options.envFiles !== undefined) {
        settings.rehydra = {
          ...(options.redactValues !== undefined
            ? { redactValues: options.redactValues }
            : {}),
          ...(options.envFiles !== undefined
            ? { envFiles: options.envFiles }
            : {}),
        };
      }
      return settings as unknown;
    },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => undefined,
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    events: { on: () => () => undefined, emit: () => undefined },
  } as unknown as ExtensionAPI;

  void api;

  return { ctx, handlers, sessionId, cwd, api };
}

/** 取出某个事件类型的已注册 handler；不存在则抛错。 */
export function eventHandler(
  mock: MockPiContext,
  name: string,
): AnyHandler {
  const entry = mock.handlers.find((h) => h.name === name);
  if (entry === undefined) {
    throw new Error(`event handler not registered: ${name}`);
  }
  return entry.handler;
}