/**
 * OpenCode Plugin V2 structural types.
 *
 * Declared locally instead of importing `@opencode/plugin` so the SDK keeps no
 * hard runtime/type dependency on OpenCode. Only the shapes this plugin
 * actually touches are modelled; extra fields are tolerated through index
 * signatures.
 */

import type { AnonymizerSessionImpl } from "../../storage/session-base.js";

/** Log levels accepted by the OpenCode app logger. */
export type PluginLogLevel = "debug" | "info" | "warn" | "error";

/** Level-scoped logging sink. Implementations must swallow their own failures. */
export interface V2Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

/** Context handed to the scrubber: which session to scrub and where to log. */
export interface ScrubContext {
  sessionID: string;
  logger: V2Logger;
}

/** Resolves (creating on first use) the anonymizer session for a session ID. */
export type SessionResolver = (sessionID: string) => AnonymizerSessionImpl;

/** A registered hook. Calling `dispose()` removes it. */
export interface HookRegistration {
  dispose(): Promise<void> | void;
}

/** One entry in a Session request's system prompt. */
export interface SystemPart {
  type: "text";
  text: string;
  [key: string]: unknown;
}

/** Tool call state as carried by V1-style OpenCode message parts. */
export interface MessagePartState {
  status?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

/** A content/part entry in an OpenCode message (V2 `content` or V1 `parts`). */
export interface MessagePart {
  type?: string;
  id?: string;
  callID?: string;
  text?: unknown;
  input?: unknown;
  result?: unknown;
  state?: MessagePartState;
  [key: string]: unknown;
}

/** OpenCode message. V2 uses `content`; `parts`/`info` keep V1 compatibility. */
export interface Message {
  role?: string;
  sessionID?: string;
  content?: MessagePart[];
  parts?: MessagePart[];
  info?: { sessionID?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Payload of the `context` / `compaction` / `generate` / `title` session hooks. */
export interface SessionRequestEvent {
  readonly sessionID: string;
  system: SystemPart[];
  messages: Message[];
  [key: string]: unknown;
}

/**
 * Which request produced an HTTP response. Only `primary` carries the answer
 * text shown to the user; the others never contain rehydratable PII.
 */
export type HttpResponseKind = "primary" | "compaction" | "title" | "generate";

/** Payload of the `http.response` session hook. */
export interface HttpResponseEvent {
  readonly sessionID: string;
  readonly kind: HttpResponseKind;
  response: Response;
  [key: string]: unknown;
}

/** Payload of the `experimental.ws.receive` session hook. */
export interface WsReceiveEvent {
  readonly sessionID: string;
  /**
   * Which request produced the frame. Only `primary` carries the answer text;
   * the others must never be rehydrated, or PII would leak into user-visible
   * surfaces such as the session title.
   */
  readonly kind: HttpResponseKind;
  frame: string;
  [key: string]: unknown;
}

export interface SessionHookEvents {
  context: SessionRequestEvent;
  compaction: SessionRequestEvent;
  generate: SessionRequestEvent;
  title: SessionRequestEvent;
  "http.response": HttpResponseEvent;
  "experimental.ws.receive": WsReceiveEvent;
}

export interface SessionDomain {
  hook<Name extends keyof SessionHookEvents>(
    name: Name,
    callback: (event: SessionHookEvents[Name]) => Promise<void> | void,
  ): Promise<HookRegistration>;
}

/** Payload of `tool.hook("execute.before")`. */
export interface ToolBeforeEvent {
  tool: string;
  sessionID: string;
  input: unknown;
  [key: string]: unknown;
}

interface ToolAfterEventBase {
  tool: string;
  sessionID: string;
  input: unknown;
  [key: string]: unknown;
}

export interface ToolAfterCompletedEvent extends ToolAfterEventBase {
  status: "completed";
  result: unknown;
}

export interface ToolAfterErrorEvent extends ToolAfterEventBase {
  status: "error";
  error: unknown;
}

/** Payload of `tool.hook("execute.after")`; discriminated by `status`. */
export type ToolAfterEvent = ToolAfterCompletedEvent | ToolAfterErrorEvent;

export interface ToolHookEvents {
  "execute.before": ToolBeforeEvent;
  "execute.after": ToolAfterEvent;
}

export interface ToolDomain {
  hook<Name extends keyof ToolHookEvents>(
    name: Name,
    callback: (event: ToolHookEvents[Name]) => Promise<void> | void,
  ): Promise<HookRegistration>;
}

/** Input accepted by the V1-style `client.app.log` sink, probed at runtime. */
export interface OpencodeLogInput {
  body: {
    service: string;
    level: PluginLogLevel;
    message: string;
    extra?: Record<string, unknown>;
  };
}

export interface OpencodeClient {
  app?: { log?: (input: OpencodeLogInput) => unknown };
}

/**
 * The subset of the OpenCode V2 plugin `Context` this plugin uses. Unknown
 * fields are tolerated so a host rename does not crash the plugin.
 */
export interface RehydraPluginContext {
  readonly session: SessionDomain;
  readonly tool: ToolDomain;
  /** Raw plugin options passed through OpenCode configuration. */
  readonly options?: Readonly<Record<string, unknown>> | undefined;
  /** V2 project location (`ctx.location.directory`). */
  readonly location?: { readonly directory?: string } | undefined;
  /** V1-style project directory fallbacks. */
  readonly directory?: string;
  readonly worktree?: string;
  /** Optional V1-style logging sink. */
  readonly client?: OpencodeClient;
  [key: string]: unknown;
}

/** Returned by `setup()` to release registered hooks. */
export type Cleanup = () => Promise<void> | void;

export type RehydraPluginSetup = (
  ctx: RehydraPluginContext,
) => Promise<Cleanup | void> | Cleanup | void;

/** OpenCode Plugin V2 shape. */
export interface Plugin {
  readonly id: string;
  readonly setup: RehydraPluginSetup;
}

export type RehydraPlugin = Plugin;

/** Backwards-compatible aliases for the V2 naming used by sibling helpers. */
export type V2PluginContext = RehydraPluginContext;
export type V2PluginSetup = RehydraPluginSetup;
export type V2Plugin = Plugin;
export type V2Cleanup = Cleanup;
