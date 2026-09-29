/**
 * Plugin V2 hook registration.
 *
 * Every hook is defensive: a tool rehydrate failure is logged and swallowed so
 * OpenCode keeps running. Scrub failures are the exception — they are logged
 * and rethrown so OpenCode aborts the request instead of forwarding raw PII.
 *
 * Each hook is registered independently: a single rejected registration is
 * logged and skipped without blocking the others.
 */

import { deepRehydrate } from "./deep-rehydrate.js";
import { scrubMessages } from "./scrub-messages.js";
import type { ScrubMessagesOptions } from "./scrub-messages.js";
import type { AnonymizationState } from "./anon-state.js";
import type {
  HookRegistration,
  RehydraPluginContext,
  SessionResolver,
  V2Logger,
} from "./types.js";

export interface RegisterHooksDeps {
  readonly logger: V2Logger;
  readonly resolveSession: SessionResolver;
  readonly state: AnonymizationState;
  readonly rehydraInstruction: string;
  readonly tagPrefix: string;
  readonly scrubOptions: ScrubMessagesOptions;
}

const CONTEXT_HOOK_NAMES = ["context", "compaction", "generate"] as const;

/** Normalizes an unknown thrown value into a loggable message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Serializes a value for change detection without throwing on cycles. */
function stringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Registers the `context`, `compaction`, and `generate` session hooks. Each
 * scrubs the request messages in place and, once anything was anonymized,
 * appends the rehydra instruction to the system prompt.
 */
export async function registerSessionContextHook(
  ctx: RehydraPluginContext,
  deps: RegisterHooksDeps,
): Promise<HookRegistration[]> {
  const registrations: HookRegistration[] = [];
  for (const name of CONTEXT_HOOK_NAMES) {
    try {
      const registration = await ctx.session.hook(name, async (event) => {
        try {
          await scrubMessages(
            event.messages,
            { sessionID: event.sessionID, logger: deps.logger },
            deps.resolveSession,
            deps.state,
            deps.scrubOptions,
          );
          if (deps.state.hasAnonymized) {
            event.system.push({
              type: "text",
              text: deps.rehydraInstruction,
            });
          }
        } catch (error) {
          deps.logger.error(`rehydra session ${name} hook failed`, {
            error: errorMessage(error),
          });
          // Fail closed: surface the scrub failure so OpenCode aborts the
          // request instead of sending unscrubbed messages to the model.
          throw error;
        }
      });
      registrations.push(registration);
    } catch (error) {
      deps.logger.error(`failed to register rehydra session ${name} hook`, {
        error: errorMessage(error),
      });
    }
  }
  return registrations;
}

/**
 * Registers the `title` hook. Only the messages are scrubbed; no system
 * instruction is injected so title generation is unaffected.
 */
export async function registerSessionTitleHook(
  ctx: RehydraPluginContext,
  deps: RegisterHooksDeps,
): Promise<HookRegistration[]> {
  try {
    const registration = await ctx.session.hook("title", async (event) => {
      try {
        await scrubMessages(
          event.messages,
          { sessionID: event.sessionID, logger: deps.logger },
          deps.resolveSession,
          deps.state,
          deps.scrubOptions,
        );
      } catch (error) {
        deps.logger.error("rehydra session title hook failed", {
          error: errorMessage(error),
        });
        // Fail closed, as above.
        throw error;
      }
    });
    return [registration];
  } catch (error) {
    deps.logger.error("failed to register rehydra session title hook", {
      error: errorMessage(error),
    });
    return [];
  }
}

/**
 * Registers `tool.hook("execute.before")`, restoring PII tags in tool
 * arguments in place before the tool runs locally.
 */
export async function registerToolBeforeHook(
  ctx: RehydraPluginContext,
  deps: RegisterHooksDeps,
): Promise<HookRegistration[]> {
  try {
    const registration = await ctx.tool.hook("execute.before", async (event) => {
      try {
        const session = deps.resolveSession(event.sessionID);
        const before = stringify(event.input);
        event.input = await deepRehydrate(event.input, session, deps.tagPrefix);
        if (stringify(event.input) !== before) {
          deps.logger.info("rehydrated PII tags in tool args", {
            tool: event.tool,
          });
        }
      } catch (error) {
        deps.logger.error("rehydra tool execute.before hook failed", {
          tool: event.tool,
          error: errorMessage(error),
        });
      }
    });
    return [registration];
  } catch (error) {
    deps.logger.error("failed to register rehydra tool execute.before hook", {
      error: errorMessage(error),
    });
    return [];
  }
}

/**
 * Registers `tool.hook("execute.after")`, restoring PII tags in a completed
 * tool result. Failed executions are skipped.
 */
export async function registerToolAfterHook(
  ctx: RehydraPluginContext,
  deps: RegisterHooksDeps,
): Promise<HookRegistration[]> {
  try {
    const registration = await ctx.tool.hook("execute.after", async (event) => {
      try {
        if (event.status !== "completed") return;
        const session = deps.resolveSession(event.sessionID);
        const before = stringify(event.result);
        event.result = await deepRehydrate(event.result, session, deps.tagPrefix);
        if (stringify(event.result) !== before) {
          deps.logger.info("rehydrated PII tags in tool result", {
            tool: event.tool,
          });
        }
      } catch (error) {
        deps.logger.error("rehydra tool execute.after hook failed", {
          tool: event.tool,
          error: errorMessage(error),
        });
      }
    });
    return [registration];
  } catch (error) {
    deps.logger.error("failed to register rehydra tool execute.after hook", {
      error: errorMessage(error),
    });
    return [];
  }
}
