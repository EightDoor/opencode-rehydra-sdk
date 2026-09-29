/**
 * Rehydra OpenCode Plugin — Plugin V2.
 *
 * Uses OpenCode Plugin V2 hooks to anonymize secrets before they reach the LLM
 * and rehydrate PII tags before local tool execution:
 * - session.hook("context" | "compaction" | "generate") — anonymize all request
 *   messages in place and inject the rehydra instruction when needed.
 * - session.hook("title") — anonymize the title request messages only.
 * - tool.hook("execute.before") — rehydrate PII tags in tool arguments.
 * - tool.hook("execute.after") — rehydrate PII tags in completed tool results.
 * - session.hook("http.response") — rehydrate PII tags in the primary answer
 *   body (JSON and SSE) before OpenCode renders it.
 * - session.hook("experimental.ws.receive") — rehydrate PII tags in WebSocket
 *   frames carrying model output.
 */

import { createAnonymizer } from "../core/anonymizer.js";
import type { Anonymizer } from "../core/anonymizer.js";
import { AnonymizerSessionImpl } from "../storage/session-base.js";
import { InMemoryPIIStorageProvider } from "../storage/in-memory.js";
import { InMemoryKeyProvider } from "../crypto/index.js";
import {
  DEFAULT_TAG_FORMAT,
  PIIType,
  SECRET_PII_TYPES,
  createDefaultPolicy,
} from "../types/index.js";
import type { AnonymizationPolicy } from "../types/index.js";
import type { RehydraPluginOptions } from "./types.js";
import { buildPIISystemInstruction } from "../proxy/system-instruction.js";
import { buildTagPrefix } from "../utils/regex.js";
import { githubUsernameRecognizer } from "./github-username.js";
import { protectIdentityTags } from "./identity-recognizer.js";
import { gitIdentityRecognizer } from "./git-identity.js";
import { AnonymizationState } from "./v2/anon-state.js";
import { createLogger } from "./v2/logger.js";
import {
  anonymizerConfigFromOptions,
  normalizePluginOptions,
  policyFromOptions,
} from "./v2/options.js";
import { SessionStore } from "./v2/sessions.js";
import {
  registerSessionContextHook,
  registerSessionTitleHook,
  registerToolAfterHook,
  registerToolBeforeHook,
} from "./v2/register-hooks.js";
import type { RegisterHooksDeps } from "./v2/register-hooks.js";
import {
  InMemoryRehydrateTailStore,
  rehydrateHttpResponse,
  rehydrateWsFrame,
} from "./v2/response-rehydrate.js";
import type { ScrubMessagesOptions } from "./v2/scrub-messages.js";
import type {
  Cleanup,
  HookRegistration,
  Plugin,
  RehydraPluginContext,
  SessionResolver,
  V2Logger,
} from "./v2/types.js";

/**
 * Resolves the project directory from the V2 context, falling back through the
 * legacy V1 fields and finally the process working directory.
 */
export function directoryFromContext(ctx: RehydraPluginContext): string {
  const location = ctx.location?.directory;
  if (typeof location === "string" && location.length > 0) return location;
  if (typeof ctx.directory === "string" && ctx.directory.length > 0) {
    return ctx.directory;
  }
  if (typeof ctx.worktree === "string" && ctx.worktree.length > 0) {
    return ctx.worktree;
  }
  return process.cwd();
}

/** Normalizes an unknown thrown value into a loggable message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Registers the response-side hooks that restore PII tags in model output.
 *
 * Both registrations are best-effort: if OpenCode does not expose a hook (or
 * rejects it), the failure is logged and the remaining hooks still work.
 */
async function registerResponseHooks(
  ctx: RehydraPluginContext,
  registrations: HookRegistration[],
  logger: V2Logger,
  resolveSession: SessionResolver,
  responseDeps: {
    tagPrefix: string;
    tagClose: string;
    tailStore: InMemoryRehydrateTailStore;
  },
): Promise<void> {
  try {
    const httpRegistration = await ctx.session.hook(
      "http.response",
      async (event) => {
        try {
          const session = resolveSession(event.sessionID);
          await rehydrateHttpResponse(event, {
            rehydrate: (input) => session.rehydrate(input),
            log: logger,
            sessionID: event.sessionID,
            kind: event.kind,
            tagPrefix: responseDeps.tagPrefix,
            tagClose: responseDeps.tagClose,
            tailStore: responseDeps.tailStore,
          });
        } catch (error) {
          logger.error("rehydra http.response hook failed", {
            error: errorMessage(error),
          });
        }
      },
    );
    registrations.push(httpRegistration);
  } catch (error) {
    logger.error("failed to register rehydra http.response hook", {
      error: errorMessage(error),
    });
  }

  try {
    const wsRegistration = await ctx.session.hook(
      "experimental.ws.receive",
      async (event) => {
        try {
          const session = resolveSession(event.sessionID);
          await rehydrateWsFrame(event, {
            rehydrate: (input) => session.rehydrate(input),
            log: logger,
            sessionID: event.sessionID,
            tagPrefix: responseDeps.tagPrefix,
            tagClose: responseDeps.tagClose,
            tailStore: responseDeps.tailStore,
          });
        } catch (error) {
          logger.error("rehydra experimental.ws.receive hook failed", {
            error: errorMessage(error),
          });
        }
      },
    );
    registrations.push(wsRegistration);
  } catch (error) {
    logger.error("failed to register rehydra experimental.ws.receive hook", {
      error: errorMessage(error),
    });
  }
}

/**
 * Creates a Rehydra plugin for OpenCode.
 *
 * @example
 * ```typescript
 * // .opencode/plugins/rehydra.ts
 * import { createRehydraPlugin } from "rehydra/opencode-plugin";
 * export default createRehydraPlugin({
 *   envFiles: [".env", ".env.local"],
 * });
 * ```
 */
export function createRehydraPlugin(options?: RehydraPluginOptions): Plugin {
  return {
    id: "rehydra",
    async setup(ctx: RehydraPluginContext): Promise<Cleanup> {
      const directory = directoryFromContext(ctx);
      const logger = createLogger(ctx, "rehydra");

      const registrations: HookRegistration[] = [];
      const tailStore = new InMemoryRehydrateTailStore();
      let anonymizer: Anonymizer | undefined;

      // Releases every resource acquired by this setup. It is idempotent and
      // isolates each dispose so one throwing registration cannot strand the
      // others or the anonymizer. Called by the returned cleanup and by the
      // failure path below.
      let disposed = false;
      const disposeAll = async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        const pending = registrations.splice(0, registrations.length);
        await Promise.all(
          pending.map(async (registration) => {
            try {
              await registration.dispose();
            } catch (error) {
              logger.warn("failed to dispose rehydra hook", {
                error: errorMessage(error),
              });
            }
          }),
        );
        tailStore.clear();
        if (anonymizer !== undefined) {
          try {
            await anonymizer.dispose();
          } catch (error) {
            logger.warn("failed to dispose rehydra anonymizer", {
              error: errorMessage(error),
            });
          }
        }
      };

      let succeeded = false;
      try {
        // Constructor options (local config scripts) take precedence over
        // options supplied by OpenCode itself; both are untrusted and normalized
        // below.
        const resolved = normalizePluginOptions(
          { ...ctx.options, ...options },
          directory,
        );
        const anonymizerConfig = anonymizerConfigFromOptions(resolved, directory);
        const tagFormat =
          anonymizerConfig.tagFormat ?? resolved.tagFormat ?? DEFAULT_TAG_FORMAT;
        const tagPrefix = buildTagPrefix(tagFormat);
        const rehydraInstruction = `<rehydra>\n${buildPIISystemInstruction(tagFormat)}\n</rehydra>`;

        const keyProvider = new InMemoryKeyProvider();
        const piiStorage = new InMemoryPIIStorageProvider();

        const createdAnonymizer = createAnonymizer({
          ...anonymizerConfig,
          tagFormat,
          keyProvider,
          piiStorageProvider: piiStorage,
        });
        anonymizer = createdAnonymizer;
        if (resolved.vcsIdentities === true) {
          createdAnonymizer
            .getRegistry()
            .register(protectIdentityTags(githubUsernameRecognizer, tagFormat));
          createdAnonymizer
            .getRegistry()
            .register(protectIdentityTags(gitIdentityRecognizer, tagFormat));
        }
        await createdAnonymizer.initialize();

        // Base policy: URL and IP_ADDRESS disabled by default.
        // `policyFromOptions` re-adds the opt-in secret types the anonymizer
        // registers internally.
        const disableTypes = resolved.disableTypes ?? ["URL", "IP_ADDRESS"];
        const policy = policyFromOptions(resolved);
        const locale = resolved.locale;

        const identityPolicy = (
          types: PIIType[],
        ): Partial<AnonymizationPolicy> => {
          const defaults = createDefaultPolicy();
          const configPolicy = anonymizerConfig.defaultPolicy;
          const enabledTypes = new Set(
            policy?.enabledTypes ??
              configPolicy?.enabledTypes ??
              defaults.enabledTypes,
          );
          const regexEnabledTypes = new Set(
            policy?.regexEnabledTypes ??
              configPolicy?.regexEnabledTypes ??
              defaults.regexEnabledTypes,
          );
          if (anonymizerConfig.secrets?.enabled === true) {
            for (const type of SECRET_PII_TYPES) {
              if (!disableTypes.includes(type)) {
                enabledTypes.add(type);
                regexEnabledTypes.add(type);
              }
            }
          }
          for (const type of types) {
            if (!disableTypes.includes(type)) {
              enabledTypes.add(type);
              regexEnabledTypes.add(type);
            }
          }
          return {
            ...policy,
            enabledTypes,
            regexEnabledTypes,
            reuseIdsForRepeatedPII: true,
          };
        };

        // One session per OpenCode session, keyed by sessionID.
        const sessionStore = new SessionStore();
        const resolveSession = (sessionID: string): AnonymizerSessionImpl =>
          sessionStore.get(
            sessionID,
            () =>
              new AnonymizerSessionImpl(
                createdAnonymizer,
                sessionID,
                piiStorage,
                keyProvider,
              ),
          );
        const state = new AnonymizationState();
        const scrubOptions: ScrubMessagesOptions = {
          locale,
          policy,
          vcsIdentities: resolved.vcsIdentities === true,
          identityPolicy,
        };

        const deps: RegisterHooksDeps = {
          logger,
          resolveSession,
          state,
          rehydraInstruction,
          tagPrefix,
          scrubOptions,
        };

        // Register each hook group independently: a rejected registration must
        // not prevent the remaining groups from being installed.
        const registerGroup = async (
          label: string,
          register: () => Promise<HookRegistration[] | void>,
        ): Promise<void> => {
          try {
            const registered = await register();
            if (registered !== undefined) {
              registrations.push(...registered);
            }
          } catch (error) {
            logger.error(`failed to register rehydra ${label} hooks`, {
              error: errorMessage(error),
            });
          }
        };

        await registerGroup("session context", () =>
          registerSessionContextHook(ctx, deps),
        );
        await registerGroup("session title", () =>
          registerSessionTitleHook(ctx, deps),
        );
        await registerGroup("tool execute.before", () =>
          registerToolBeforeHook(ctx, deps),
        );
        await registerGroup("tool execute.after", () =>
          registerToolAfterHook(ctx, deps),
        );

        // Response hooks restore the real values in model output before
        // OpenCode renders them. Registration is best-effort: an unavailable
        // hook must not prevent the plugin (and OpenCode) from starting.
        await registerGroup("response", () =>
          registerResponseHooks(ctx, registrations, logger, resolveSession, {
            tagPrefix,
            tagClose: tagFormat.close,
            tailStore,
          }),
        );

        logger.info("plugin initialized", {
          envFiles: anonymizerConfig.secrets?.envFiles,
          redactValueCount: resolved.redactValues?.length ?? 0,
          disableTypes,
        });

        succeeded = true;
        return disposeAll;
      } finally {
        if (!succeeded) {
          await disposeAll();
        }
      }
    },
  };
}

/** Default plugin instance used by `opencode.json`. */
export const plugin: Plugin = createRehydraPlugin();

export default plugin;
