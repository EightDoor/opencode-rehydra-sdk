/**
 * PII tag rehydration for OpenCode Plugin V2 tool hooks.
 */

import type { AnonymizerSessionImpl } from "../../storage/session-base.js";

/**
 * Recursively rehydrate all string values containing PII tags.
 * Returns a new value (for strings/arrays) or the same object mutated in-place
 * (for plain objects). The in-place mutation is required because OpenCode's
 * tool hooks use the original reference for execution — replacing the object
 * wholesale has no effect.
 */
export async function deepRehydrate(
  value: unknown,
  session: AnonymizerSessionImpl,
  tagPrefix: string,
): Promise<unknown> {
  if (typeof value === "string") {
    if (value.includes(tagPrefix)) {
      return session.rehydrate(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      (value as unknown[])[i] = await deepRehydrate(value[i], session, tagPrefix);
    }
    return value as unknown;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      obj[key] = await deepRehydrate(obj[key], session, tagPrefix);
    }
    return obj;
  }
  return value;
}
