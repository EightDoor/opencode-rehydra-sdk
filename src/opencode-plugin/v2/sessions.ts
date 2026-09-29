/**
 * In-memory session registry for the V2 plugin.
 *
 * OpenCode identifies a conversation by `sessionID`; each conversation gets
 * its own {@link AnonymizerSessionImpl} so PII maps stay isolated. Sessions are
 * process-local and intentionally not persisted here.
 */

import type { AnonymizerSessionImpl } from "../../storage/session-base.js";

/** Lazily creates and memoizes one session per OpenCode session ID. */
export class SessionStore {
  private readonly map: Map<string, AnonymizerSessionImpl> = new Map();

  /**
   * Returns the session for `sessionID`, creating it via `factory` on first use.
   */
  get(
    sessionID: string,
    factory: () => AnonymizerSessionImpl,
  ): AnonymizerSessionImpl {
    let session = this.map.get(sessionID);
    if (session === undefined) {
      session = factory();
      this.map.set(sessionID, session);
    }
    return session;
  }
}
