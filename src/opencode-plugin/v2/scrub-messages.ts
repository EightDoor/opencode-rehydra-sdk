/**
 * Message scrubbing for OpenCode Plugin V2 session hooks.
 *
 * Walks the messages attached to a model request and anonymizes every string
 * that can carry secrets: user/assistant/reasoning text, tool arguments,
 * completed tool output, and V1-style part state.
 *
 * The scrub runs on a deep copy; only after it completes successfully are the
 * results written back into the caller's original objects (preserving the
 * references Plugin V2 relies on). If any step throws, the originals are left
 * untouched and the error propagates so the caller can block the request
 * instead of leaking raw PII (fail-closed).
 */

import { PIIType } from "../../types/index.js";
import type {
  AnonymizationPolicy,
  AnonymizationResult,
} from "../../types/index.js";
import { vcsCommandTypes } from "../vcs-command.js";
import type { AnonymizationState } from "./anon-state.js";
import type {
  Message,
  MessagePart,
  MessagePartState,
  ScrubContext,
  SessionResolver,
} from "./types.js";
import type { AnonymizerSessionImpl } from "../../storage/session-base.js";

export interface ScrubMessagesOptions {
  /** Locale hint passed to `anonymize()`; defaults to the plugin option. */
  locale?: string;
  /** Base policy (URL/IP disabled by default). */
  policy?: Partial<AnonymizationPolicy>;
  /** Whether the VCS identity recognizers are enabled. */
  vcsIdentities: boolean;
  /** Builds the extended policy that enables identity types for a VCS output. */
  identityPolicy: (types: PIIType[]) => Partial<AnonymizationPolicy>;
}

export interface ScrubResult {
  /** Entities anonymized during this call. */
  scrubbed: number;
  byType: Record<string, number>;
}

/** Reads a shell command from a tool input object, if present. */
function extractCommand(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

/** Resolves the session ID carried by a message, for diagnostic logging only. */
function messageSessionID(message: Message): string | undefined {
  const info = message.info;
  if (info !== undefined && info !== null && typeof info === "object") {
    const sessionID = info.sessionID;
    if (typeof sessionID === "string" && sessionID.length > 0) return sessionID;
  }
  const sessionID = message.sessionID;
  if (typeof sessionID === "string" && sessionID.length > 0) return sessionID;
  return undefined;
}

/** Deep-clones a JSON-like value (message payloads contain no class instances). */
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    const items = value as unknown[];
    return items.map((item) => deepClone(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      out[key] = deepClone(item);
    }
    return out as T;
  }
  return value;
}

/**
 * Copies the fields the scrubber mutates from a scrubbed part back onto the
 * original part, keeping the original object identities intact.
 */
function restorePart(
  original: MessagePart | undefined,
  scrubbed: MessagePart | undefined,
): void {
  if (
    original === undefined ||
    original === null ||
    scrubbed === undefined ||
    scrubbed === null
  ) {
    return;
  }
  original.text = scrubbed.text;
  original.input = scrubbed.input;
  original.result = scrubbed.result;
  restorePartState(original.state, scrubbed.state);
}

/** Copies mutable tool-state fields back onto the original part state. */
function restorePartState(
  original: MessagePartState | undefined,
  scrubbed: MessagePartState | undefined,
): void {
  if (
    original === undefined ||
    original === null ||
    scrubbed === undefined ||
    scrubbed === null
  ) {
    return;
  }
  original.input = scrubbed.input;
  original.error = scrubbed.error;
  original.output = scrubbed.output;
}

/** Applies scrub results from `source` back onto the original message parts. */
function restoreScrubbedParts(
  originalMessages: Message[],
  scrubbedMessages: Message[],
): void {
  for (let index = 0; index < originalMessages.length; index++) {
    const original = originalMessages[index];
    const scrubbed = scrubbedMessages[index];
    if (
      original === undefined ||
      original === null ||
      scrubbed === undefined ||
      scrubbed === null
    ) {
      continue;
    }
    restorePartArray(original.content, scrubbed.content);
    restorePartArray(original.parts, scrubbed.parts);
  }
}

function restorePartArray(
  originalParts: MessagePart[] | undefined,
  scrubbedParts: MessagePart[] | undefined,
): void {
  if (!Array.isArray(originalParts) || !Array.isArray(scrubbedParts)) {
    return;
  }
  const length = Math.min(originalParts.length, scrubbedParts.length);
  for (let index = 0; index < length; index++) {
    restorePart(originalParts[index], scrubbedParts[index]);
  }
}

/**
 * Anonymizes the messages of a session request in place.
 *
 * @returns the number of entities removed and a per-type breakdown for logging.
 */
export async function scrubMessages(
  eventMessages: Message[],
  ctx: ScrubContext,
  resolveSession: SessionResolver,
  state: AnonymizationState,
  options: ScrubMessagesOptions,
): Promise<ScrubResult> {
  let scrubbed = 0;
  const byType: Record<string, number> = {};

  const record = (result: AnonymizationResult): void => {
    if (result.stats.totalEntities <= 0) return;
    state.hasAnonymized = true;
    scrubbed += result.stats.totalEntities;
    for (const [type, count] of Object.entries(result.stats.countsByType)) {
      byType[type] = (byType[type] ?? 0) + count;
    }
  };

  // Recursively anonymize a value. Object keys are preserved so execution
  // arguments and JSON property names stay intact.
  const scrubValue = async (
    value: unknown,
    session: AnonymizerSessionImpl,
    policy: Partial<AnonymizationPolicy> | undefined,
  ): Promise<unknown> => {
    if (typeof value === "string") {
      const result = await session.anonymize(value, options.locale, policy);
      record(result);
      return result.anonymizedText;
    }
    if (Array.isArray(value)) {
      const items = value as unknown[];
      const out: unknown[] = [];
      for (const item of items) {
        out.push(await scrubValue(item, session, policy));
      }
      return out;
    }
    if (value !== null && typeof value === "object") {
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(source)) {
        out[key] = await scrubValue(item, session, policy);
      }
      return out;
    }
    return value;
  };

  // Tool call id → shell command, so a later `tool-result` can use the identity
  // policy its matching `tool-call` requires.
  const commandByCallID = new Map<string, string>();

  const policyForCommand = (
    command: unknown,
  ): Partial<AnonymizationPolicy> | undefined => {
    if (!options.vcsIdentities || typeof command !== "string") return undefined;
    const commands = vcsCommandTypes(command);
    const types: PIIType[] = [];
    if (commands.has("github")) types.push(PIIType.GITHUB_USERNAME);
    if (commands.has("git")) types.push(PIIType.PERSON);
    if (types.length === 0) return undefined;
    return options.identityPolicy(types);
  };

  const commandFor = (part: MessagePart): string | undefined => {
    const callID = part.callID ?? part.id;
    if (callID === undefined) return undefined;
    return commandByCallID.get(callID);
  };

  const scrubPart = async (
    part: MessagePart,
    session: AnonymizerSessionImpl,
  ): Promise<void> => {
    // V1-style part state (kept so the scrubber works for both message shapes).
    const partState = part.state;
    if (
      partState !== undefined &&
      partState !== null &&
      typeof partState === "object"
    ) {
      if (partState.input !== undefined) {
        const command = extractCommand(partState.input);
        if (command !== undefined) {
          commandByCallID.set(part.callID ?? part.id ?? "", command);
        }
        partState.input = await scrubValue(partState.input, session, options.policy);
      }
      if (typeof partState.error === "string") {
        partState.error = (await scrubValue(
          partState.error,
          session,
          options.policy,
        )) as string;
      }
      if (partState.status === "completed" && typeof partState.output === "string") {
        const command = extractCommand(partState.input) ?? commandFor(part);
        const policyOverride = policyForCommand(command) ?? options.policy;
        partState.output = (await scrubValue(
          partState.output,
          session,
          policyOverride,
        )) as string;
      }
    }

    // V2 tool arguments.
    if (part.type === "tool-call" && part.input !== undefined) {
      const command = extractCommand(part.input);
      if (command !== undefined && part.id !== undefined) {
        commandByCallID.set(part.id, command);
      }
      part.input = await scrubValue(part.input, session, options.policy);
    }

    // V2 tool output.
    if (part.type === "tool-result" && part.result !== undefined) {
      const command = extractCommand(part.input) ?? commandFor(part);
      const policyOverride = policyForCommand(command) ?? options.policy;
      part.result = await scrubValue(part.result, session, policyOverride);
    }

    // Any textual part (text, reasoning, compaction).
    if (typeof part.text === "string") {
      const result = await session.anonymize(part.text, options.locale, options.policy);
      record(result);
      part.text = result.anonymizedText;
    }
  };

  // Scrub a deep copy first; the originals are only touched after the whole
  // pass succeeds, so a mid-way failure cannot send partially scrubbed PII.
  const workingMessages = deepClone(eventMessages);
  const session = resolveSession(ctx.sessionID);

  for (const message of workingMessages) {
    if (message === null || typeof message !== "object") continue;
    const messageSession = messageSessionID(message);
    if (messageSession !== undefined && messageSession !== ctx.sessionID) {
      ctx.logger.debug("message sessionID differs from event sessionID", {
        eventSessionID: ctx.sessionID,
        messageSessionID: messageSession,
      });
    }

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part !== null && typeof part === "object") {
          await scrubPart(part, session);
        }
      }
    }
    if (Array.isArray(message.parts)) {
      for (const part of message.parts) {
        if (part !== null && typeof part === "object") {
          await scrubPart(part, session);
        }
      }
    }
  }

  restoreScrubbedParts(eventMessages, workingMessages);

  if (scrubbed > 0) {
    const nonZero: Record<string, number> = {};
    for (const [type, count] of Object.entries(byType)) {
      if (count > 0) nonZero[type] = count;
    }
    ctx.logger.info(`scrubbed ${scrubbed} secret(s) from messages`, {
      scrubbed: nonZero,
      messageCount: eventMessages.length,
    });
  } else {
    ctx.logger.debug("no secrets found in messages", {
      messageCount: eventMessages.length,
    });
  }

  return { scrubbed, byType };
}
