/**
 * Tracks whether any anonymization has occurred during a plugin's lifetime.
 *
 * The system-prompt instruction is only injected once anonymization has
 * actually happened, so the flag lives outside the individual hooks.
 */
export class AnonymizationState {
  hasAnonymized = false;

  /** Clears the flag, e.g. when a fresh plugin instance takes over. */
  reset(): void {
    this.hasAnonymized = false;
  }
}
