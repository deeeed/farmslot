// error.ts — structured config-resolution failures with teach-the-escape
// actions. Shape-compatible with the gateway's GatewayMethodError so
// server.ts can serialize code/userAction/details into response frames.

export class SlotConfigError extends Error {
  readonly code: string;
  readonly userAction?: string;
  readonly details?: unknown;

  constructor(code: string, message: string, options?: { userAction?: string; details?: unknown }) {
    super(message);
    this.name = 'SlotConfigError';
    this.code = code;
    this.userAction = options?.userAction;
    this.details = options?.details;
  }
}
