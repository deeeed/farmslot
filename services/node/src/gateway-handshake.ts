import WebSocket from 'ws';

import {
  type Frame,
  type GatewayAuthConnectResult,
  Methods,
  type NativeExecutionNodeDeclaration,
  PROTOCOL_VERSION,
  type RecipeRuntimeCapabilityDeclaration,
  type RequestFrame,
  type ResponseFrame,
} from '@farmslot/protocol';

import type { GatewayCredential } from './gateway-credential.js';

/**
 * Gateway request transport for the node daemon: one request, one settled
 * promise. A request settles on exactly one of: matching response frame,
 * socket close, socket error, send failure, or timeout — and removes every
 * listener it registered either way, so a rejected registration can never sit
 * silently on an open socket and a torn-down socket cannot leak handlers.
 */

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class GatewayRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly userAction?: string,
  ) {
    super(message);
    this.name = 'GatewayRequestError';
  }
}

/**
 * Rejections that faster retries cannot fix: the gateway evaluated the
 * credential or registration and refused it. Transport-class failures
 * (timeout, close, error) keep the normal reconnect climb.
 */
const DETERMINISTIC_REJECTION_CODES = new Set([
  'AUTH_FAILED',
  'AUTH_FORBIDDEN',
  'AUTH_RATE_LIMITED',
  'AUTH_REQUIRED',
  'AUTH_INVALID_CLIENT',
  'INVALID_PARAMS',
]);

export function isDeterministicHandshakeRejection(error: unknown): boolean {
  return error instanceof GatewayRequestError && DETERMINISTIC_REJECTION_CODES.has(error.code);
}

let requestSeq = 0;

export function sendGatewayRequest<T>(
  socket: WebSocket,
  method: string,
  params: unknown,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(
      new GatewayRequestError('SOCKET_NOT_OPEN', `Gateway WebSocket is not open (${method})`),
    );
  }
  requestSeq += 1;
  const id = `${method}-${process.pid}-${requestSeq}`;
  const frame: RequestFrame = { type: 'req', id, method, params };
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
      outcome();
    };
    const onMessage = (raw: WebSocket.RawData) => {
      const response = responseFrameFor(id, raw);
      if (!response) return;
      if (response.ok) {
        settle(() => resolve(response.payload as T));
        return;
      }
      settle(() =>
        reject(
          new GatewayRequestError(
            response.error?.code ?? 'GATEWAY_ERROR',
            response.error?.message ?? `Gateway rejected ${method}`,
            response.error?.userAction,
          ),
        ),
      );
    };
    const onClose = (code: number, reason: Buffer) => {
      const detail = reason.length > 0 ? `${code} ${reason.toString()}` : String(code);
      settle(() =>
        reject(
          new GatewayRequestError(
            'SOCKET_CLOSED',
            `Gateway closed the connection before answering ${method} (close ${detail})`,
          ),
        ),
      );
    };
    const onError = (error: Error) => {
      settle(() =>
        reject(new GatewayRequestError('SOCKET_ERROR', `${method} failed: ${error.message}`)),
      );
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new GatewayRequestError(
            'TIMEOUT',
            `Gateway did not answer ${method} within ${timeoutMs}ms`,
          ),
        ),
      );
    }, timeoutMs);

    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.on('error', onError);
    socket.send(JSON.stringify(frame), (error) => {
      if (!error) return;
      settle(() =>
        reject(new GatewayRequestError('SEND_FAILED', `${method} failed: ${error.message}`)),
      );
    });
  });
}

/**
 * The response frame for `id`, or null when this frame is something else: a
 * gateway request, an event, another request's response, or a non-JSON
 * (binary) payload. Those frames belong to the daemon's main listener; this
 * filter only asks whether the frame answers the request it was armed for.
 */
function responseFrameFor(id: string, raw: WebSocket.RawData): ResponseFrame | null {
  let parsed: Frame;
  try {
    parsed = JSON.parse(raw.toString()) as Frame;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.type !== 'res' || parsed.id !== id)
    return null;
  return parsed;
}

export interface NodeAuthenticateOptions {
  machine: string;
  credential: GatewayCredential | null;
  timeoutMs?: number;
}

/** Step one of the handshake: prove the node-subject credential. */
export function authenticateNode(
  socket: WebSocket,
  options: NodeAuthenticateOptions,
): Promise<GatewayAuthConnectResult> {
  const { credential } = options;
  return sendGatewayRequest<GatewayAuthConnectResult>(
    socket,
    Methods.AUTH_CONNECT,
    {
      clientKind: 'node',
      clientName: options.machine,
      protocolVersion: PROTOCOL_VERSION,
      ...(credential?.token ? { token: credential.token } : {}),
      ...(credential?.password ? { password: credential.password } : {}),
    },
    { timeoutMs: options.timeoutMs },
  );
}

export interface NodeRegisterOptions {
  machine: string;
  pid: number;
  capabilities: RecipeRuntimeCapabilityDeclaration[];
  nativeSessions?: NativeExecutionNodeDeclaration;
  timeoutMs?: number;
}

export interface NodeRegistrationResult {
  registered: boolean;
}

/**
 * Step two: register the machine. The gateway only lists a node after this
 * ACK, so callers must not report "connected" before it resolves — the
 * native-owner and machine-assignment checks run here, not in auth.connect.
 */
export function registerNode(
  socket: WebSocket,
  options: NodeRegisterOptions,
): Promise<NodeRegistrationResult> {
  return sendGatewayRequest<NodeRegistrationResult>(
    socket,
    'node.connect',
    {
      machine: options.machine,
      pid: options.pid,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: options.capabilities,
      ...(options.nativeSessions ? { nativeSessions: options.nativeSessions } : {}),
    },
    { timeoutMs: options.timeoutMs },
  );
}

/**
 * Operator-facing failure line. Carries the gateway's code and message (which
 * never include the credential) plus its teach-the-escape action when present.
 */
export function describeHandshakeFailure(error: unknown): {
  code: string;
  message: string;
  userAction?: string;
} {
  if (error instanceof GatewayRequestError) {
    return { code: error.code, message: error.message, userAction: error.userAction };
  }
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
}
