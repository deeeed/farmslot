// method-error.ts — structured RPC method failures with teach-the-escape actions.
// Thrown anywhere below the RPC router; server.ts serializes code/userAction/details
// into the response frame so CLI/UI clients can show the exact next command.

export class GatewayMethodError extends Error {
  readonly code: string;
  readonly userAction?: string;
  readonly details?: unknown;

  constructor(code: string, message: string, options?: { userAction?: string; details?: unknown }) {
    super(message);
    this.name = 'GatewayMethodError';
    this.code = code;
    this.userAction = options?.userAction;
    this.details = options?.details;
  }
}

/** Marks an unexpected implementation fault that must never cross the RPC response boundary. */
export class GatewayInternalError extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = 'GatewayInternalError';
  }
}
