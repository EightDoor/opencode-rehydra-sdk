/**
 * Shared helpers for driving the OpenCode Plugin V2 shape under test.
 *
 * The V2 plugin receives a `ctx` exposing `session.hook` / `tool.hook`
 * registration functions. These helpers build a minimal fake context that
 * records every registration, so tests can invoke the registered handlers
 * directly and assert their behaviour.
 */

import type {
  HookRegistration,
  RehydraPluginContext,
} from "../../src/opencode-plugin/v2/types.js";

/**
 * Handler signature is intentionally loose: tests pass concrete event objects
 * whose type varies per hook.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MockHookHandler = (event: any) => Promise<void> | void;

export interface MockHook {
  name: string;
  handler: MockHookHandler;
}

export interface MockV2Context {
  ctx: RehydraPluginContext;
  sessionHooks: MockHook[];
  toolHooks: MockHook[];
  /** Hook names whose returned registration has been disposed. */
  disposed: string[];
}

export interface MockV2ContextOptions {
  directory?: string;
  options?: Record<string, unknown>;
}

/**
 * Creates a fake V2 plugin context whose hook registrations are captured in
 * `sessionHooks` / `toolHooks`. Each registration's `dispose()` records the
 * hook name in `disposed`.
 */
export function createMockV2Context(
  options: MockV2ContextOptions = {},
): MockV2Context {
  const sessionHooks: MockHook[] = [];
  const toolHooks: MockHook[] = [];
  const disposed: string[] = [];

  function createRegister(list: MockHook[]) {
    return async (
      name: string,
      handler: MockHookHandler,
    ): Promise<HookRegistration> => {
      list.push({ name, handler });
      return {
        dispose: async () => {
          disposed.push(name);
        },
      };
    };
  }

  const ctx = {
    options: options.options,
    location: { directory: options.directory ?? "/test" },
    client: { app: { log: async () => {} } },
    session: { hook: createRegister(sessionHooks) },
    tool: { hook: createRegister(toolHooks) },
  } as unknown as RehydraPluginContext;

  return { ctx, sessionHooks, toolHooks, disposed };
}

/** Returns the handler registered for a session hook, or throws if absent. */
export function sessionHandler(
  mock: MockV2Context,
  name: string,
): MockHookHandler {
  const hook = mock.sessionHooks.find((entry) => entry.name === name);
  if (hook === undefined) {
    throw new Error(`session hook not registered: ${name}`);
  }
  return hook.handler;
}

/** Returns the handler registered for a tool hook, or throws if absent. */
export function toolHandler(
  mock: MockV2Context,
  name: string,
): MockHookHandler {
  const hook = mock.toolHooks.find((entry) => entry.name === name);
  if (hook === undefined) {
    throw new Error(`tool hook not registered: ${name}`);
  }
  return hook.handler;
}
