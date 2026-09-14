// errors.ts — Typed run-engine control-flow errors shared by scoped step owners.

/** BlockedRunError detail for a dispatch that declined to replace a live retained worker. */
export const RETAINED_SESSION_HANDOFF_HOLD = 'retained-session-handoff';

export class BlockedRunError extends Error {
  readonly detail: string;

  constructor(message: string, detail = message) {
    super(message);
    this.name = 'BlockedRunError';
    this.detail = detail;
  }
}
