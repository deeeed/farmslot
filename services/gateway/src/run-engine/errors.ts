// errors.ts — Typed run-engine control-flow errors shared by scoped step owners.

export class BlockedRunError extends Error {
  readonly detail: string;

  constructor(message: string, detail = message) {
    super(message);
    this.name = 'BlockedRunError';
    this.detail = detail;
  }
}
