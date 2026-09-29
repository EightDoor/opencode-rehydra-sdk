/**
 * Shared tail buffering for streamed PII-tag rehydration.
 *
 * Model output arrives in fragments: a single `<PII .../>` tag can be split
 * across SSE events, WebSocket byte chunks, or JSON delta frames. Rehydrating
 * a fragment in isolation would emit an unterminated tag (or worse, drop the
 * real value), so incomplete fragments are held back and prepended to the next
 * fragment of the same stream.
 *
 * Two buffers are maintained per session:
 * - a byte/text tail for raw text payloads (SSE `data:` bodies, non-JSON WS
 *   frames),
 * - a JSON pointer tail so each string field of a JSON delta frame continues
 *   from the fragment left by the previous frame.
 */

/** Longest PII tag fragment we hold back while awaiting its closing delimiter. */
export const MAX_TAG_TAIL_LENGTH = 256;

/** Default tag prefix, matching `DEFAULT_TAG_FORMAT`. */
export const DEFAULT_TAG_PREFIX = "<PII";

/** Default tag close delimiter. */
export const DEFAULT_TAG_CLOSE = "/>";

/**
 * Per-session storage for fragments held back between streamed payloads.
 *
 * Text tails are keyed by session; JSON tails are keyed by session and a JSON
 * pointer so a tag split inside a delta field is reassembled on the matching
 * field of the next frame.
 */
export interface RehydrateTailStore {
  /** Returns the held text fragment for a session (empty when none). */
  get(sessionID: string): string;
  /** Replaces the held text fragment; an empty string clears it. */
  set(sessionID: string, tail: string): void;
  /** Returns the held fragment for a JSON pointer (empty when none). */
  getJsonTail(sessionID: string, pointer: string): string;
  /** Replaces a JSON-pointer fragment; an empty string clears it. */
  setJsonTail(sessionID: string, pointer: string, tail: string): void;
  /** Clears every fragment (text and JSON) for a session. */
  delete(sessionID: string): void;
  /** Clears every fragment for every session. */
  clear(): void;
}

/** Default in-memory tail store. */
export class InMemoryRehydrateTailStore implements RehydrateTailStore {
  private readonly textTails = new Map<string, string>();
  private readonly jsonTails = new Map<string, Map<string, string>>();

  get(sessionID: string): string {
    return this.textTails.get(sessionID) ?? "";
  }

  set(sessionID: string, tail: string): void {
    if (tail.length === 0) {
      this.textTails.delete(sessionID);
      return;
    }
    this.textTails.set(sessionID, tail);
  }

  getJsonTail(sessionID: string, pointer: string): string {
    return this.jsonTails.get(sessionID)?.get(pointer) ?? "";
  }

  setJsonTail(sessionID: string, pointer: string, tail: string): void {
    const pointers = this.jsonTails.get(sessionID);
    if (tail.length === 0) {
      if (pointers === undefined) return;
      pointers.delete(pointer);
      if (pointers.size === 0) this.jsonTails.delete(sessionID);
      return;
    }
    if (pointers === undefined) {
      this.jsonTails.set(sessionID, new Map([[pointer, tail]]));
      return;
    }
    pointers.set(pointer, tail);
  }

  delete(sessionID: string): void {
    this.textTails.delete(sessionID);
    this.jsonTails.delete(sessionID);
  }

  clear(): void {
    this.textTails.clear();
    this.jsonTails.clear();
  }
}

/**
 * Finds the start of a trailing, unterminated PII tag fragment.
 *
 * Returns `-1` when the text has no incomplete tag, so a caller can safely
 * emit it. When a fragment is found, the caller must hold it back (prepending
 * it to the next fragment) instead of emitting a truncated tag.
 */
export function incompleteTagStart(
  text: string,
  tagPrefix: string,
  tagClose: string,
): number {
  const start = text.lastIndexOf(tagPrefix);
  if (start >= 0 && text.indexOf(tagClose, start) === -1) {
    return start;
  }
  // A tag can also be split before its full prefix has arrived (e.g. the frame
  // ends with `<PI`). Hold back the longest trailing prefix fragment.
  const maxPrefix = Math.min(text.length, tagPrefix.length - 1);
  for (let length = maxPrefix; length >= 1; length--) {
    const suffix = text.slice(text.length - length);
    if (suffix === tagPrefix.slice(0, length)) {
      return text.length - length;
    }
  }
  return -1;
}

/** Result of splitting a restored string into emit-safe text and a held tail. */
export interface TagTailSplit {
  /** Text safe to emit now. */
  emitted: string;
  /** Unterminated tag fragment to carry to the next payload. */
  tail: string;
}

/**
 * Splits a restored string at its trailing unterminated tag fragment.
 *
 * When the fragment is longer than {@link MAX_TAG_TAIL_LENGTH} the whole string
 * is emitted: holding an unbounded fragment risks stalling the stream, so the
 * cap forces a flush.
 */
export function splitTrailingTag(
  text: string,
  tagPrefix: string,
  tagClose: string,
): TagTailSplit {
  const start = incompleteTagStart(text, tagPrefix, tagClose);
  if (start < 0) {
    return { emitted: text, tail: "" };
  }
  const fragment = text.slice(start);
  if (fragment.length > MAX_TAG_TAIL_LENGTH) {
    return { emitted: text, tail: "" };
  }
  return { emitted: text.slice(0, start), tail: fragment };
}

/** Context shared by every string leaf of one JSON frame. */
export interface JsonTailContext {
  readonly store: RehydrateTailStore;
  readonly sessionID: string;
  /** Namespace preventing different surfaces from sharing pointer keys. */
  readonly pointerPrefix: string;
  readonly tagPrefix: string;
  readonly tagClose: string;
}

/** Outcome of walking a JSON value with per-pointer tail handling. */
export interface WalkJsonTailResult<T> {
  value: T;
  changed: boolean;
}

/**
 * Walks a JSON value, restoring every string leaf.
 *
 * Each leaf is prefixed with the fragment previously held for its JSON pointer
 * (so a tag split across delta frames is reassembled), then any trailing
 * unterminated fragment is held back for the next frame. `changed` reports
 * whether any leaf differs from the original, letting callers keep the frame
 * byte-for-byte when nothing needed rewriting.
 */
export async function walkJsonWithTail<T>(
  value: T,
  rehydrate: (input: string) => Promise<string>,
  ctx: JsonTailContext,
  pointer = "",
): Promise<WalkJsonTailResult<T>> {
  if (typeof value === "string") {
    const key = ctx.pointerPrefix + pointer;
    const held = ctx.store.getJsonTail(ctx.sessionID, key);
    const restored = await rehydrate(held + value);
    const { emitted, tail } = splitTrailingTag(
      restored,
      ctx.tagPrefix,
      ctx.tagClose,
    );
    ctx.store.setJsonTail(ctx.sessionID, key, tail);
    return { value: emitted as unknown as T, changed: emitted !== value };
  }

  if (Array.isArray(value)) {
    const items = value as unknown[];
    const output: unknown[] = [];
    let changed = false;
    for (let index = 0; index < items.length; index++) {
      const result = await walkJsonWithTail(
        items[index],
        rehydrate,
        ctx,
        `${pointer}/${index}`,
      );
      output.push(result.value);
      changed = changed || result.changed;
    }
    return { value: output as unknown as T, changed };
  }

  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    let changed = false;
    for (const key of Object.keys(source)) {
      const result = await walkJsonWithTail(
        source[key],
        rehydrate,
        ctx,
        `${pointer}/${key}`,
      );
      output[key] = result.value;
      changed = changed || result.changed;
    }
    return { value: output as unknown as T, changed };
  }

  return { value, changed: false };
}
