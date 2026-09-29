/**
 * Server-Sent Events body rewriting for the V2 `http.response` hook.
 *
 * When the model streams its answer as SSE (`text/event-stream`), each `data:`
 * line may carry PII tags that must be restored before OpenCode renders the
 * text. `event:` / `id:` / comment lines are structural and never modified.
 *
 * Two strategies are applied per `data:` payload:
 * - JSON payloads are parsed, every string leaf is restored, and the value is
 *   re-serialised. This keeps quotes / backslashes / newlines inside restored
 *   values correctly escaped. A tag split across the delta field of two frames
 *   is carried on the matching JSON pointer.
 * - Non-JSON payloads fall back to raw string replacement. A tag split across
 *   two events is carried in a per-response text tail.
 *
 * Frames are only rewritten once their blank-line terminator has been seen, so
 * a tag is never processed while its frame is still buffered. Frame boundaries
 * may be `\n\n`, `\r\n\r\n`, or a bare `\r\r`; the original separator bytes are
 * preserved on output. On failure the original body is passed through and the
 * reason is reported via `error`.
 */

import {
  DEFAULT_TAG_CLOSE,
  DEFAULT_TAG_PREFIX,
  InMemoryRehydrateTailStore,
  splitTrailingTag,
  walkJsonWithTail,
} from "./rehydrate-tail.js";
import type { RehydrateTailStore } from "./rehydrate-tail.js";

/** Which strategy produced a rewritten body. */
export type SseRewriteMode = "json" | "text" | "passthrough";

/** Outcome of rewriting an SSE body. */
export interface SseRewriteResult {
  /** Full rewritten SSE body. */
  body: string;
  /** Whether a `data:` line actually changed (i.e. a PII tag was restored). */
  rewrote: boolean;
  /** Strategy used: `json`/`text` when rewritten, `passthrough` otherwise. */
  mode: SseRewriteMode;
  /** Set when an internal failure forced the original body to pass through. */
  error?: string;
}

/**
 * Per-response state shared across the events of one SSE stream.
 *
 * `dataTail` holds an unterminated tag fragment from the previous text event;
 * `store` holds per-JSON-pointer fragments so a tag split across two JSON
 * delta frames is reassembled.
 */
export interface SseTailState {
  /** Unterminated tag fragment carried between SSE events (text payloads). */
  dataTail: string;
  readonly store: RehydrateTailStore;
  readonly sessionID: string;
  readonly tagPrefix: string;
  readonly tagClose: string;
}

/** Creates a fresh per-response tail state, applying option defaults. */
export function createSseTailState(
  options: {
    store?: RehydrateTailStore;
    sessionID?: string;
    tagPrefix?: string;
    tagClose?: string;
  } = {},
): SseTailState {
  return {
    dataTail: "",
    store: options.store ?? new InMemoryRehydrateTailStore(),
    sessionID: options.sessionID ?? "",
    tagPrefix: options.tagPrefix ?? DEFAULT_TAG_PREFIX,
    tagClose: options.tagClose ?? DEFAULT_TAG_CLOSE,
  };
}

/** Options accepted by {@link SseStreamRewriter}. */
export interface SseStreamRewriterOptions {
  tailStore?: RehydrateTailStore;
  sessionID?: string;
  tagPrefix?: string;
  tagClose?: string;
}

interface FrameRewrite {
  frame: string;
  rewrote: boolean;
  mode: SseRewriteMode;
}

interface PayloadRewrite {
  payload: string;
  changed: boolean;
  mode: "json" | "text";
}

/** Splits a frame into lines while capturing the exact line endings. */
const LINE_SEPARATOR = /(\r\n|\n|\r)/;

/** Splits a body into frames while capturing the exact frame separators. */
const FRAME_SEPARATOR = /(\r\n\r\n|\n\n|\r\r)/;

/** Normalizes an unknown thrown value into a loggable message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Restores a single `data:` payload.
 *
 * JSON payloads are parsed so string leaves are restored before
 * re-serialisation; a payload that parses but contains no tag is returned byte
 * for byte unchanged so formatting/whitespace is preserved. Non-JSON payloads
 * are rehydrated as text, carrying an incomplete trailing fragment in `state`
 * so the next event can complete it.
 */
async function rewriteDataPayload(
  payload: string,
  rehydrate: (input: string) => Promise<string>,
  state: SseTailState,
): Promise<PayloadRewrite> {
  let parsed: unknown;
  let isJson = true;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    isJson = false;
  }

  if (isJson) {
    const result = await walkJsonWithTail(parsed, rehydrate, {
      store: state.store,
      sessionID: state.sessionID,
      pointerPrefix: "sse:",
      tagPrefix: state.tagPrefix,
      tagClose: state.tagClose,
    });
    if (!result.changed) {
      return { payload, changed: false, mode: "json" };
    }
    return { payload: JSON.stringify(result.value), changed: true, mode: "json" };
  }

  const combined = state.dataTail + payload;
  const restored = await rehydrate(combined);
  const { emitted, tail } = splitTrailingTag(
    restored,
    state.tagPrefix,
    state.tagClose,
  );
  state.dataTail = tail;
  return { payload: emitted, changed: emitted !== payload, mode: "text" };
}

/**
 * Rewrites the `data:` lines of a single complete SSE frame. The original
 * `data: ` / `data:` prefix and spacing are preserved, as are the line endings
 * (`\n`, `\r\n`, or `\r`).
 */
async function rewriteFrame(
  frame: string,
  rehydrate: (input: string) => Promise<string>,
  state: SseTailState,
): Promise<FrameRewrite> {
  if (frame.length === 0) {
    return { frame, rewrote: false, mode: "passthrough" };
  }

  let rewrote = false;
  let mode: SseRewriteMode = "passthrough";
  const parts = frame.split(LINE_SEPARATOR);
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? "";
    if (!line.startsWith("data:")) {
      // `event:`, `id:`, `retry:` and `:` comments pass through untouched.
      continue;
    }
    const afterPrefix = line.slice("data:".length);
    const hasSpace = afterPrefix.startsWith(" ");
    const prefix = hasSpace ? "data: " : "data:";
    const payload = hasSpace ? afterPrefix.slice(1) : afterPrefix;
    const result = await rewriteDataPayload(payload, rehydrate, state);
    if (result.changed) {
      rewrote = true;
      mode = mode === "text" || result.mode === "text" ? "text" : "json";
    }
    parts[index] = prefix + result.payload;
  }

  return { frame: parts.join(""), rewrote, mode };
}

/**
 * Rewrites every PII tag in a complete SSE body.
 *
 * The body is split on blank-line frame separators (`\n\n`, `\r\n\r\n`, or
 * `\r\r`), each frame is rewritten, and the original separators are rejoined so
 * CRLF streams stay CRLF.
 *
 * @param body - Raw SSE body as read from the response.
 * @param rehydrate - Restores PII tags in a single string.
 * @param state - Optional per-response tail state; a fresh one is created when
 *   omitted so tags split across the frames of a single body still reassemble.
 */
export async function rewriteSseBody(
  body: string,
  rehydrate: (input: string) => Promise<string>,
  state: SseTailState = createSseTailState(),
): Promise<SseRewriteResult> {
  try {
    const parts = body.split(FRAME_SEPARATOR);
    let rewrote = false;
    let sawJson = false;
    let sawText = false;
    for (let index = 0; index < parts.length; index += 2) {
      const result = await rewriteFrame(parts[index] ?? "", rehydrate, state);
      parts[index] = result.frame;
      if (result.rewrote) {
        rewrote = true;
        if (result.mode === "text") {
          sawText = true;
        } else {
          sawJson = true;
        }
      }
    }
    const rewrittenBody = parts.join("");
    const mode: SseRewriteMode = !rewrote
      ? "passthrough"
      : sawText
        ? "text"
        : sawJson
          ? "json"
          : "passthrough";
    return { body: rewrittenBody, rewrote, mode };
  } catch (error) {
    // The original body was not emitted by us, so drop any held fragment to
    // avoid it leaking into a later, unrelated frame.
    state.dataTail = "";
    return {
      body,
      rewrote: false,
      mode: "passthrough",
      error: errorMessage(error),
    };
  }
}

/** Finds the end offset of the last complete frame separator in `text`. */
function lastFrameBoundaryEnd(text: string): number {
  const matcher = new RegExp(FRAME_SEPARATOR.source, "g");
  let end = -1;
  let match = matcher.exec(text);
  while (match !== null) {
    end = match.index + match[0].length;
    match = matcher.exec(text);
  }
  return end;
}

/**
 * Streaming SSE rewriter for `http.response` bodies.
 *
 * Chunks are decoded and appended to an internal buffer. Only complete frames
 * (terminated by a blank line, LF or CRLF) are rewritten and emitted, so a PII
 * tag split across two chunks is held back until the frame completes. The
 * per-response {@link SseTailState} additionally carries tag fragments split
 * across events. {@link flush} rewrites any trailing frame that was never
 * terminated and emits the final held fragment.
 */
export class SseStreamRewriter {
  private readonly decoder = new TextDecoder();
  private readonly state: SseTailState;
  private pending = "";

  constructor(
    private readonly rehydrate: (input: string) => Promise<string>,
    private readonly onError?: (message: string) => void,
    options: SseStreamRewriterOptions = {},
  ) {
    this.state = createSseTailState(options);
  }

  /** Feeds one byte chunk; returns the text confirmed safe to emit. */
  async push(chunk: Uint8Array): Promise<string> {
    this.pending += this.decoder.decode(chunk, { stream: true });
    return this.drainCompleteFrames();
  }

  /** Rewrites and returns any trailing frame at end of stream. */
  async flush(): Promise<string> {
    this.pending += this.decoder.decode();
    const remainder = this.pending;
    this.pending = "";
    let output = "";
    if (remainder.length > 0) {
      const result = await rewriteSseBody(
        remainder,
        this.rehydrate,
        this.state,
      );
      if (result.error !== undefined) {
        this.onError?.(result.error);
      }
      output += result.body;
    }
    // Emit any fragment still held from the final event, then release the
    // per-response state so it cannot leak into a later stream.
    if (this.state.dataTail.length > 0) {
      output += this.state.dataTail;
      this.state.dataTail = "";
    }
    this.state.store.clear();
    return output;
  }

  private async drainCompleteFrames(): Promise<string> {
    const boundaryEnd = lastFrameBoundaryEnd(this.pending);
    if (boundaryEnd < 0) {
      return "";
    }
    const complete = this.pending.slice(0, boundaryEnd);
    this.pending = this.pending.slice(boundaryEnd);
    const result = await rewriteSseBody(complete, this.rehydrate, this.state);
    if (result.error !== undefined) {
      this.onError?.(result.error);
    }
    return result.body;
  }
}
