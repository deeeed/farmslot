import { WebSocket as NodeWebSocket } from 'ws';

import {
  type EventFrame,
  type Frame,
  type PersonSessionAuth,
  PersonSessionClient,
  type ResponseFrame,
} from '@farmslot/protocol';

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

function rpcFailure(
  error: ResponseFrame['error'],
  message = 'Unknown gateway error',
  code = 'METHOD_ERROR',
): GatewayRpcError {
  return new GatewayRpcError(
    error?.message || message,
    error?.code || code,
    error?.userAction,
    error?.details,
  );
}

export interface GatewayConnection {
  call<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
  /** Subscribe to broadcast events; returns an unsubscribe function. */
  onEvent(handler: (event: EventFrame) => void): () => void;
  /** Fires once when the socket closes for any reason; returns an unsubscribe. */
  onClose(handler: () => void): () => void;
  close(): void;
}

export interface GatewayCredential {
  token?: string;
  password?: string;
  personSession?: PersonSessionAuth;
  persistPersonSession?: (value: PersonSessionAuth | null) => Promise<void>;
}

export class GatewayClient {
  private url: string;
  private timeout: number;
  private credential: GatewayCredential | null;
  private personClient: PersonSessionClient | null = null;
  private activeConnection: GatewayConnection | null = null;

  constructor(opts: GatewayClientOpts) {
    this.url = opts.url;
    this.timeout = opts.timeout;
    this.credential = effectiveCredential(opts.credential);
  }

  async currentCredentials(
    forceRefresh = false,
  ): Promise<{ token?: string; password?: string } | null> {
    const credential = this.credential;
    if (!this.personClient && credential?.personSession) {
      this.personClient = new PersonSessionClient({
        storage: {
          load: async () => credential.personSession ?? null,
          save: async (value) => {
            await credential.persistPersonSession?.(value);
            if (value) credential.personSession = value;
            else delete credential.personSession;
          },
        },
        request: (method, params, accessToken) =>
          new GatewayClient({
            url: this.url,
            timeout: this.timeout,
            credential: accessToken ? { token: accessToken } : null,
          }).call(method, params),
        onAccess: async (grant) => {
          if (this.activeConnection)
            await this.activeConnection.call('auth.connect', {
              clientKind: 'ui',
              clientName: 'farmslot-tui',
              token: grant.accessToken,
            });
        },
      });
    }
    return this.personClient
      ? { token: await this.personClient.accessToken(forceRefresh) }
      : credential;
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
    const credential = await this.currentCredentials(true);
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
      else entry.reject(rpcFailure(frame.error));
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
        const needsAuth = Boolean(credential?.token || credential?.password);
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
                ...(credential?.token ? { token: credential.token } : {}),
                ...(credential?.password ? { password: credential.password } : {}),
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
    const connection: GatewayConnection = {
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
    this.activeConnection = connection;
    this.personClient?.startRefresh(() => connection.close());
    connection.onClose(() => {
      if (this.activeConnection !== connection) return;
      this.activeConnection = null;
      this.personClient?.stopRefresh();
    });
    return connection;
  }

  async callWithEvents<T = unknown>(
    method: string,
    params: unknown = {},
    onEvent?: (event: EventFrame) => void,
  ): Promise<T> {
    const credential = await this.currentCredentials();
    if (this.personClient)
      return this.personClient.withAccess((token) =>
        this.callWithCredential<T>(method, params, onEvent, { token }),
      );
    return this.callWithCredential<T>(method, params, onEvent, credential);
  }

  private callWithCredential<T>(
    method: string,
    params: unknown,
    onEvent: ((event: EventFrame) => void) | undefined,
    credential: { token?: string; password?: string } | null,
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
        if (credential?.token || credential?.password) {
          authPending = true;
          ws.send(
            JSON.stringify({
              type: 'req',
              id: authId,
              method: 'auth.connect',
              params: {
                clientKind: 'ui',
                clientName: 'farmslot-cli',
                ...(credential.token ? { token: credential.token } : {}),
                ...(credential.password ? { password: credential.password } : {}),
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
              reject(rpcFailure(frame.error, 'Gateway authentication failed', 'AUTH_FAILED')),
            );
          }
          return;
        }

        if (frame.id !== reqId) return;

        if (frame.ok) {
          finish(() => resolve(frame.payload as T));
        } else {
          finish(() => reject(rpcFailure(frame.error)));
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
