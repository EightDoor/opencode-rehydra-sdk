/**
 * Response rehydration for the V2 `http.response` / `experimental.ws.receive`
 * hooks.
 *
 * The model only ever sees PII tags; its output must be rewritten back to the
 * real values before the user sees it. Referencing `deps.rehydrate` keeps the
 * PII map lookup in the caller (the session store) so this module stays free of
 * storage concerns.
 *
 * Rewriting strategy by surface:
 * - JSON `http.response`: parse, walk string leaves, re-serialise.
 * - SSE `http.response`: streamed through a {@link SseStreamRewriter}; only
 *   complete frames are rewritten so a tag split across chunks, across SSE
 *   events, or split inside a streamed delta field is never emitted truncated.
 * - WebSocket frames: only `primary` frames are rehydrated. JSON frames are
 *   parsed and walked, carrying a tag split across the delta field of two frames
 *   on the matching JSON pointer; non-JSON frames fall back to text replacement
 *   with a per-session tail buffer that holds an incomplete trailing PII tag
 *   until the next frame completes it.
 *
 * Every failure is logged and the original payload is passed through — a failed
 * rehydration must never corrupt the response or break OpenCode.
 */

import { walkJson } from "../../utils/json-walk.js";
import { SseStreamRewriter } from "./sse.js";
import {
  DEFAULT_TAG_CLOSE,
  DEFAULT_TAG_PREFIX,
  InMemoryRehydrateTailStore,
  splitTrailingTag,
  walkJsonWithTail,
} from "./rehydrate-tail.js";
import type { RehydrateTailStore } from "./rehydrate-tail.js";
import type { HttpResponseKind, V2Logger } from "./types.js";

// Re-exported so existing consumers keep importing the tail store from here.
export { InMemoryRehydrateTailStore } from "./rehydrate-tail.js";
export type { RehydrateTailStore } from "./rehydrate-tail.js";

/**
 * Fallback store used when a caller does not inject one. Tests should inject a
 * fresh store to keep sessions isolated.
 */
const sharedTailStore = new InMemoryRehydrateTailStore();

export interface ResponseRehydrateDeps {
  /** Restores PII tags in a single string. */
  rehydrate: (input: string) => Promise<string>;
  log: V2Logger;
  sessionID: string;
  kind: HttpResponseKind;
  /** Tag prefix used to detect an incomplete trailing tag (`<PII`). */
  tagPrefix?: string;
  /** Tag close delimiter used to detect a complete tag (`/>`). */
  tagClose?: string;
  /** Per-session WebSocket tail buffer; defaults to a shared instance. */
  tailStore?: RehydrateTailStore;
}

/** Dependencies accepted by the WebSocket frame rehydrator. */
export interface WsFrameRehydrateDeps {
  rehydrate: (input: string) => Promise<string>;
  log: V2Logger;
  sessionID?: string;
  tagPrefix?: string;
  tagClose?: string;
  tailStore?: RehydrateTailStore;
}

/** Normalizes an unknown thrown value into a loggable message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds a replacement response with the same status and headers.
 *
 * `content-length` is dropped because the rehydrated body differs in length and
 * a stale value would truncate or over-read it.
 */
function withBody(original: Response, body: string): Response {
  const headers = new Headers(original.headers);
  headers.delete("content-length");
  return new Response(body, {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

/**
 * Rehydrates a JSON response body on `event.response`.
 *
 * JSON is the safest surface to rewrite: `JSON.parse` / `JSON.stringify` keeps
 * the payload valid while every string leaf is passed through `rehydrate`.
 */
async function rehydrateJsonResponse(
  event: { response: Response },
  deps: ResponseRehydrateDeps,
): Promise<void> {
  const rawBody = await event.response.clone().text();
  const parsed = JSON.parse(rawBody) as unknown;
  const restored = await walkJson(parsed, deps.rehydrate);
  event.response = withBody(event.response, JSON.stringify(restored));
}

/**
 * Rehydrates a streamed SSE response body by piping it through a
 * {@link SseStreamRewriter}. The body is never fully buffered, so OpenCode keeps
 * receiving incremental frames.
 */
async function rehydrateSseResponse(
  event: { response: Response },
  deps: ResponseRehydrateDeps,
): Promise<void> {
  const rewriter = new SseStreamRewriter(
    deps.rehydrate,
    (message) => {
      deps.log.error("rehydra SSE frame rewrite failed", {
        sessionID: deps.sessionID,
        error: message,
      });
    },
    {
      sessionID: deps.sessionID,
      tagPrefix: deps.tagPrefix,
      tagClose: deps.tagClose,
    },
  );
  const encoder = new TextEncoder();
  const source = event.response.body;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller): Promise<void> {
      const text = await rewriter.push(chunk);
      if (text.length > 0) {
        controller.enqueue(encoder.encode(text));
      }
    },
    async flush(controller): Promise<void> {
      const text = await rewriter.flush();
      if (text.length > 0) {
        controller.enqueue(encoder.encode(text));
      }
    },
  });

  const headers = new Headers(event.response.headers);
  headers.delete("content-length");
  event.response = new Response(readable, {
    status: event.response.status,
    statusText: event.response.statusText,
    headers,
  });

  if (source === null) {
    await writable.close();
    return;
  }
  source.pipeTo(writable).catch((error: unknown) => {
    deps.log.error("rehydra SSE stream failed", {
      sessionID: deps.sessionID,
      error: errorMessage(error),
    });
  });
}

/**
 * Rehydrates an HTTP response produced for a session request.
 *
 * Only `primary` responses are processed: `title` / `compaction` / `generate`
 * responses are not user-facing, so restoring real values there would only leak
 * PII. Unsupported content types are left untouched.
 */
export async function rehydrateHttpResponse(
  event: { response: Response },
  deps: ResponseRehydrateDeps,
): Promise<void> {
  if (deps.kind !== "primary") {
    return;
  }
  try {
    const contentType = event.response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      await rehydrateJsonResponse(event, deps);
      return;
    }
    if (contentType.includes("text/event-stream")) {
      await rehydrateSseResponse(event, deps);
    }
  } catch (error) {
    deps.log.error("rehydra http.response hook failed", {
      sessionID: deps.sessionID,
      kind: deps.kind,
      error: errorMessage(error),
    });
  }
}

/**
 * Restores a WebSocket frame in place.
 *
 * Only `primary` frames are rehydrated: `title` / `compaction` / `generate`
 * frames are not user-facing, so restoring real values there would only leak
 * PII. Any fragment held from an earlier frame is dropped on a non-primary
 * frame so it cannot surface later.
 *
 * Complete JSON frames are parsed and walked so escaped characters are handled
 * correctly; a tag split across the delta field of consecutive JSON frames is
 * carried on the matching JSON pointer. Other frames use raw replacement,
 * holding an incomplete trailing tag in a per-session text buffer until a later
 * frame completes it.
 */
export async function rehydrateWsFrame(
  event: { frame: string; kind?: HttpResponseKind },
  deps: WsFrameRehydrateDeps,
): Promise<void> {
  const store = deps.tailStore ?? sharedTailStore;
  const sessionID = deps.sessionID ?? "";
  const tagPrefix = deps.tagPrefix ?? DEFAULT_TAG_PREFIX;
  const tagClose = deps.tagClose ?? DEFAULT_TAG_CLOSE;

  if (event.kind !== "primary") {
    // Fail closed: never restore PII in a non-primary response, and drop any
    // fragment left behind by an earlier frame.
    store.delete(sessionID);
    return;
  }

  const combined = store.get(sessionID) + event.frame;
  const originalFrame = event.frame;

  try {
    let parsed: unknown;
    let isJson = true;
    try {
      parsed = JSON.parse(combined) as unknown;
    } catch {
      isJson = false;
    }

    if (isJson) {
      const result = await walkJsonWithTail(parsed, deps.rehydrate, {
        store,
        sessionID,
        pointerPrefix: "ws:",
        tagPrefix,
        tagClose,
      });
      // Preserve the frame byte-for-byte when nothing was rehydrated; otherwise
      // re-serialize so escaped characters are handled correctly. `combined`
      // includes any fragment held back from a previous frame.
      event.frame = result.changed ? JSON.stringify(result.value) : combined;
      // Clear the byte-level text tail; JSON-pointer tails were updated above.
      store.set(sessionID, "");
      return;
    }

    const restored = await deps.rehydrate(combined);
    const { emitted, tail } = splitTrailingTag(
      restored,
      tagPrefix,
      tagClose,
    );
    event.frame = emitted;
    store.set(sessionID, tail);
  } catch (error) {
    store.delete(sessionID);
    event.frame = originalFrame;
    deps.log.error("rehydra experimental.ws.receive hook failed", {
      sessionID,
      error: errorMessage(error),
    });
  }
}
