import { WebSocket as NodeWebSocket } from 'ws';

import type { EventFrame, Frame } from '@farmslot/protocol';

export interface GatewayClientOpts {
  url: string;
  timeout: number;
  /**
   * Caller-selected profile or explicit test credential.
   * Absent credentials never trigger discovery.
   */
  credential?: GatewayCredential | null;
}

/** Transport-level failure (refused/timeout/closed) — distinct from RPC errors. */
export class GatewayConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayConnectionError';
  }
}

/** Structured RPC failure from the gateway; userAction names the exact next command(s). */
export class GatewayRpcError extends Error {
  readonly code: string;
  readonly userAction?: string;
  readonly details?: unknown;

  constructor(message: string, code: string, userAction?: string, details?: unknown) {
    super(message);
    this.name = 'GatewayRpcError';
    this.code = code;
    this.userAction = userAction;
    this.details = details;
  }
}

export interface GatewayConnection {
  call<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
  /** Subscribe to broadcast events; returns an unsubscribe function. */
  onEvent(handler: (event: EventFrame) => void): () => void;
  /** Fires once when the socket closes for any reason; returns an unsubscribe. */
  onClose(handler: () => void): () => void;
  close(): void;
}

interface GatewayCredential {
  token?: string;
  password?: string;
}

export class GatewayClient {
  private url: string;
  private timeout: number;
  private credential: GatewayCredential | null;

  constructor(opts: GatewayClientOpts) {
    this.url = opts.url;
    this.timeout = opts.timeout;
    this.credential = effectiveCredential(opts.credential);
  }

  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    return this.callWithEvents<T>(method, params);
  }

  /**
   * Long-lived authenticated connection for the TUI: multiplexes calls over
   * one socket and forwards broadcast events. One-shot commands keep using
   * per-invocation sockets via call().
   */
  async connect(): Promise<GatewayConnection> {
    const WebSocketCtor = globalThis.WebSocket ?? NodeWebSocket;
    const ws = new WebSocketCtor(this.url);
    const pending = new Map<
      string,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const eventHandlers = new Set<(event: EventFrame) => void>();
    const closeHandlers = new Set<() => void>();
    let closed = false;
    let seq = 0;

    const failPending = (reason: Error) => {
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) entry.reject(reason);
    };

    const notifyClosed = () => {
      const handlers = [...closeHandlers];
      closeHandlers.clear();
      for (const handler of handlers) {
        try {
          handler();
        } catch {
          // A close observer must not block socket teardown or the remaining
          // observers — the connection is already gone; there is nothing the
          // client can do about a failing callback here.
        }
      }
    };

    // Persistent handlers go on before the handshake so a close during auth
    // is observed and no post-auth frame can slip past.
    ws.addEventListener('message', (evt) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String((evt as MessageEvent).data)) as Frame;
      } catch {
        // Non-JSON frames (binary capture relay) are not for this handler.
        return;
      }
      if (frame.type === 'event') {
        for (const handler of eventHandlers) handler(frame);
        return;
      }
      if (frame.type !== 'res') return;
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      if (frame.ok) entry.resolve(frame.payload);
      else
        entry.reject(
          new GatewayRpcError(
            frame.error?.message || 'Unknown gateway error',
            frame.error?.code || 'METHOD_ERROR',
            frame.error?.userAction,
            frame.error?.details,
          ),
        );
    });
    ws.addEventListener('close', () => {
      closed = true;
      failPending(new GatewayConnectionError('Connection closed unexpectedly'));
      notifyClosed();
    });

    // The auth response is a regular res frame, so the persistent message
    // handler above settles the handshake through its pending-map entry.
    const authId = 'connect-auth';
    try {
      await new Promise<void>((resolve, reject) => {
        const needsAuth = Boolean(this.credential?.token || this.credential?.password);
        const opened = setTimeout(
          () => reject(new GatewayConnectionError(`Timeout — no activity for ${this.timeout}ms`)),
          this.timeout,
        );
        pending.set(authId, {
          resolve: () => {
            clearTimeout(opened);
            resolve();
          },
          reject: (err) => {
            clearTimeout(opened);
            reject(err);
          },
        });
        ws.addEventListener('open', () => {
          if (!needsAuth) {
            pending.delete(authId);
            clearTimeout(opened);
            resolve();
            return;
          }
          ws.send(
            JSON.stringify({
              type: 'req',
              id: authId,
              method: 'auth.connect',
              params: {
                clientKind: 'ui',
                clientName: 'farmslot-tui',
                ...(this.credential?.token ? { token: this.credential.token } : {}),
                ...(this.credential?.password ? { password: this.credential.password } : {}),
              },
            }),
          );
        });
        ws.addEventListener('error', () => {
          clearTimeout(opened);
          reject(new GatewayConnectionError('Connection failed — is the gateway running?'));
        });
      });
    } catch (err) {
      // Handshake failed (timeout, refused, bad credentials): release the
      // socket so the process does not stay alive on a dead connection.
      closed = true;
      ws.close();
      throw err;
    } finally {
      pending.delete(authId);
    }

    const timeout = this.timeout;
    return {
      call<T = unknown>(
        method: string,
        params: unknown = {},
        options?: { timeoutMs?: number },
      ): Promise<T> {
        if (closed) {
          return Promise.reject(new GatewayConnectionError('Connection is closed'));
        }
        const id = `tui-${++seq}`;
        const callTimeout = options?.timeoutMs ?? timeout;
        return new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (pending.delete(id)) {
              reject(new GatewayConnectionError(`Timeout — no response for ${callTimeout}ms`));
            }
          }, callTimeout);
          pending.set(id, {
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value as T);
            },
            reject: (err) => {
              clearTimeout(timer);
              reject(err);
            },
          });
          ws.send(JSON.stringify({ type: 'req', id, method, params }));
        });
      },
      onEvent(handler: (event: EventFrame) => void): () => void {
        eventHandlers.add(handler);
        return () => eventHandlers.delete(handler);
      },
      onClose(handler: () => void): () => void {
        if (closed) {
          handler();
          return () => {};
        }
        closeHandlers.add(handler);
        return () => closeHandlers.delete(handler);
      },
      close(): void {
        if (closed) return;
        closed = true;
        eventHandlers.clear();
        // Reject in-flight calls now — the ws 'close' event arrives async.
        failPending(new GatewayConnectionError('Connection closed'));
        notifyClosed();
        ws.close();
      },
    };
  }

  async callWithEvents<T = unknown>(
    method: string,
    params: unknown = {},
    onEvent?: (event: EventFrame) => void,
  ): Promise<T> {
    const reqId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    return new Promise<T>((resolve, reject) => {
      const WebSocketCtor = globalThis.WebSocket ?? NodeWebSocket;
      const ws = new WebSocketCtor(this.url);
      let done = false;
      let timer: ReturnType<typeof setTimeout>;

      // Reset timeout on any activity — keeps streaming ops alive.
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!done) {
            done = true;
            ws.close();
            reject(new GatewayConnectionError(`Timeout — no activity for ${this.timeout}ms`));
          }
        }, this.timeout);
      };

      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
        ws.close();
      };

      const sendRequest = () => {
        ws.send(JSON.stringify({ type: 'req', id: reqId, method, params }));
      };

      const authId = `${reqId}-auth`;
      let authPending = false;

      ws.addEventListener('open', () => {
        resetTimer();
        if (this.credential?.token || this.credential?.password) {
          authPending = true;
          ws.send(
            JSON.stringify({
              type: 'req',
              id: authId,
              method: 'auth.connect',
              params: {
                clientKind: 'ui',
                clientName: 'farmslot-cli',
                ...(this.credential.token ? { token: this.credential.token } : {}),
                ...(this.credential.password ? { password: this.credential.password } : {}),
              },
            }),
          );
          return;
        }
        sendRequest();
      });

      ws.addEventListener('message', (evt) => {
        resetTimer();
        let frame: Frame;
        try {
          frame = JSON.parse(String(evt.data)) as Frame;
        } catch {
          // Non-JSON frames (binary capture relay) are not for this handler.
          return;
        }

        if (frame.type === 'event') {
          if (onEvent) onEvent(frame as EventFrame);
          return;
        }

        if (frame.type !== 'res') return;

        if (authPending && frame.id === authId) {
          authPending = false;
          if (frame.ok) {
            sendRequest();
          } else {
            finish(() =>
              reject(new Error(frame.error?.message || 'Gateway authentication failed')),
            );
          }
          return;
        }

        if (frame.id !== reqId) return;

        if (frame.ok) {
          finish(() => resolve(frame.payload as T));
        } else {
          finish(() =>
            reject(
              new GatewayRpcError(
                frame.error?.message || 'Unknown gateway error',
                frame.error?.code || 'METHOD_ERROR',
                frame.error?.userAction,
                frame.error?.details,
              ),
            ),
          );
        }
      });

      ws.addEventListener('error', () => {
        finish(() =>
          reject(new GatewayConnectionError('Connection failed — is the gateway running?')),
        );
      });

      ws.addEventListener('close', () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(new GatewayConnectionError('Connection closed unexpectedly'));
        }
      });
    });
  }
}

/** Only a caller-selected profile or explicit test credential authenticates. */
export function effectiveCredential(
  optCredential: GatewayCredential | null | undefined,
): GatewayCredential | null {
  return optCredential ?? null;
}
