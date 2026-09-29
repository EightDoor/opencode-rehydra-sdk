/**
 * OpenCode plugin logger.
 *
 * Accommodates both client shapes the plugin may receive:
 * - V2: `ctx.client.app.log({ body: { service, level, message, extra? } })`,
 *   where `client` / `app` may be absent entirely.
 * - V1: a raw client exposing `app.log(...)`.
 *
 * When no usable sink exists — or the sink throws / rejects — the message is
 * emitted to `console.warn` / `console.error` so swallowed hook failures stay
 * observable in development and tests.
 *
 * Logging is best-effort: it must never propagate into plugin hook execution.
 */

import type { V2Logger } from "./types.js";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LoggableApp {
  log?: (input: {
    body: {
      service: string;
      level: LogLevel;
      message: string;
      extra?: Record<string, unknown>;
    };
  }) => unknown;
}

interface LoggableSource {
  client?: { app?: LoggableApp };
  app?: LoggableApp;
}

/** Serializes extra context without ever throwing. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Creates a logger bound to a plugin context (or raw OpenCode client).
 *
 * @param source - Plugin context (`ctx.client.app.log`) or a raw client
 *   (`source.app.log`). Either shape may be missing.
 * @param service - Service tag reported to OpenCode's log stream.
 */
export function createLogger(source: unknown, service = "rehydra"): V2Logger {
  const candidate = source as LoggableSource | null | undefined;
  const app = candidate?.client?.app ?? candidate?.app;

  function fallback(
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    const suffix = extra === undefined ? "" : ` extra=${safeStringify(extra)}`;
    const line = `service=${service} level=${level} message=${message}${suffix}`;
    if (level === "error") {
      // eslint-disable-next-line no-console
      console.error(line);
    } else {
      // eslint-disable-next-line no-console
      console.warn(line);
    }
  }

  function log(
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    const logFn = app?.log;
    if (typeof logFn !== "function") {
      fallback(level, message, extra);
      return;
    }
    try {
      const result = logFn.call(app, {
        body: { service, level, message, extra },
      });
      if (result instanceof Promise) {
        result.catch(() => {
          fallback(level, message, extra);
        });
      }
    } catch {
      fallback(level, message, extra);
    }
  }

  return {
    debug: (message, extra) => log("debug", message, extra),
    info: (message, extra) => log("info", message, extra),
    warn: (message, extra) => log("warn", message, extra),
    error: (message, extra) => log("error", message, extra),
  };
}
