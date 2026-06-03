// WebSocket client for Farmslot gateway — request/response + event subscription

import type {
  EventFrame,
  Frame,
  GatewayAuthConnectResult,
  RequestFrame,
  ResponseFrame,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { resolveGatewayWebSocketUrl } from './gateway-url.js';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'auth_required';
type EventCallback<T = unknown> = (payload: T) => void;
type ConnectionCallback = (state: ConnectionState) => void;
type BinaryCallback = (data: ArrayBuffer) => void;

interface ImportMetaWithEnv extends ImportMeta {
  env: Record<string, string | undefined>;
}

export interface GatewayAuthCredentials {
  token?: string;
  password?: string;
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class GatewayRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'GatewayRequestError';
  }
}

const DEFAULT_TIMEOUT = 15_000;
const MAX_BACKOFF = 30_000;
const HTTP_AUTH_COOKIE = 'farmslot_gateway_credential';
const HTTP_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function resolveBrowserGatewayAuth(): GatewayAuthCredentials {
  const env = (import.meta as ImportMetaWithEnv).env;
  const token =
    env.VITE_FARMSLOT_GATEWAY_TOKEN ?? localStorage.getItem('farmslot.gateway.token') ?? undefined;
  const password =
    env.VITE_FARMSLOT_GATEWAY_PASSWORD ??
    localStorage.getItem('farmslot.gateway.password') ??
    undefined;
  return {
    ...(token ? { token } : {}),
    ...(password ? { password } : {}),
  };
}

function syncBrowserHttpAuthCookie(auth: GatewayAuthCredentials): void {
  const credential = auth.token?.trim() || auth.password?.trim();
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  if (!credential) {
    document.cookie = `${HTTP_AUTH_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0${secure}`;
    return;
  }
  document.cookie = `${HTTP_AUTH_COOKIE}=${encodeURIComponent(
    credential,
  )}; Path=/; SameSite=Lax; Max-Age=${HTTP_AUTH_COOKIE_MAX_AGE_SECONDS}${secure}`;
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private epoch = 0;
  private reqId = 0;
  private pending = new Map<string, PendingRequest>();
  private eventSubs = new Map<string, Set<EventCallback>>();
  private connSubs = new Set<ConnectionCallback>();
  private binarySubs = new Set<BinaryCallback>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private url: string;
  private auth: GatewayAuthCredentials;
  private disposed = false;
  private authBlocked = false;
  private lastAuthError: GatewayRequestError | null = null;

  constructor(url?: string, auth: GatewayAuthCredentials = resolveBrowserGatewayAuth()) {
    const env = (import.meta as ImportMetaWithEnv).env;
    // In local dev this normally stays unset and Vite proxies /ws to GATEWAY_PORT.
    // Deployed Command Center instances should set VITE_FARMSLOT_GATEWAY_URL.
    this.url = url ?? resolveGatewayWebSocketUrl(env.VITE_FARMSLOT_GATEWAY_URL, location);
    this.auth = auth;
    syncBrowserHttpAuthCookie(auth);
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get connectionEpoch(): number {
    return this.epoch;
  }

  get authError(): GatewayRequestError | null {
    return this.lastAuthError;
  }

  get gatewayUrl(): string {
    return this.url;
  }

  get authCredentialKind(): 'token' | 'password' | 'none' {
    if (this.auth.token) return 'token';
    if (this.auth.password) return 'password';
    return 'none';
  }

  setAuthCredentials(auth: GatewayAuthCredentials): void {
    this.auth = auth;
    syncBrowserHttpAuthCookie(auth);
    this.authBlocked = false;
    this.lastAuthError = null;
    localStorage.removeItem('farmslot.gateway.token');
    localStorage.removeItem('farmslot.gateway.password');
    if (auth.token) localStorage.setItem('farmslot.gateway.token', auth.token);
    if (auth.password) localStorage.setItem('farmslot.gateway.password', auth.password);
    this.ws?.close();
    this.ws = null;
    this.setState('disconnected');
  }

  connect(): void {
    if (this.disposed || this.authBlocked) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    )
      return;

    this.authBlocked = false;
    this.setState('connecting');
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.authenticate().catch((err: Error) => {
        const authError =
          err instanceof GatewayRequestError
            ? err
            : new GatewayRequestError(err.message, 'AUTH_FAILED');
        this.authBlocked = true;
        this.lastAuthError = authError;
        this.rejectAllPending(`Authentication failed: ${authError.message}`);
        this.setState('auth_required');
        this.ws?.close();
      });
    };

    this.ws.onclose = () => {
      this.rejectAllPending('Connection closed');
      if (this.authBlocked) {
        this.setState('auth_required');
        return;
      }
      this.setState('disconnected');
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };

    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (ev) => {
      // Binary frames (stream feed)
      if (ev.data instanceof ArrayBuffer) {
        for (const cb of this.binarySubs) {
          try {
            cb(ev.data);
          } catch {
            /* subscriber error */
          }
        }
        return;
      }
      try {
        const frame: Frame = JSON.parse(ev.data as string);
        if (frame.type === 'res') {
          this.handleResponse(frame as ResponseFrame);
        } else if (frame.type === 'event') {
          this.handleEvent(frame as EventFrame);
        }
      } catch {
        // Ignore malformed frames
      }
    };
  }

  private async authenticate(): Promise<void> {
    const result = await this.request<GatewayAuthConnectResult>(Methods.AUTH_CONNECT, {
      clientKind: 'ui',
      ...this.auth,
    });
    if (!result.ok) throw new Error('Gateway authentication failed');
    this.epoch += 1;
    this.backoff = 1000;
    this.lastAuthError = null;
    this.authBlocked = false;
    this.setState('connected');
  }

  disconnect(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.rejectAllPending('Client disconnected');
    this.ws?.close();
    this.ws = null;
    this.setState('disconnected');
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeout = DEFAULT_TIMEOUT,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }

    const id = String(++this.reqId);
    const frame: RequestFrame = { type: 'req', id, method, params };
    const t0 = performance.now();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeout}ms`));
      }, timeout);

      this.pending.set(id, {
        resolve: (v: unknown) => {
          const dt = performance.now() - t0;
          // Surface slow calls so the source of perceived UI latency is obvious.
          if (dt > 100) console.log(`[gateway] ${method} ${dt.toFixed(0)}ms`);
          resolve(v as T);
        },
        reject,
        timer,
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  subscribe<T = unknown>(event: string, callback: EventCallback<T>): () => void {
    let set = this.eventSubs.get(event);
    if (!set) {
      set = new Set();
      this.eventSubs.set(event, set);
    }
    set.add(callback as EventCallback);

    return () => {
      set!.delete(callback as EventCallback);
      if (set!.size === 0) this.eventSubs.delete(event);
    };
  }

  onConnectionChange(callback: ConnectionCallback): () => void {
    this.connSubs.add(callback);
    return () => {
      this.connSubs.delete(callback);
    };
  }

  onBinary(callback: BinaryCallback): () => void {
    this.binarySubs.add(callback);
    return () => {
      this.binarySubs.delete(callback);
    };
  }

  private handleResponse(frame: ResponseFrame): void {
    const req = this.pending.get(frame.id);
    if (!req) return;
    this.pending.delete(frame.id);
    clearTimeout(req.timer);

    if (frame.ok) {
      req.resolve(frame.payload);
    } else {
      req.reject(
        new GatewayRequestError(
          frame.error?.message ?? 'Unknown error',
          frame.error?.code ?? 'UNKNOWN',
        ),
      );
    }
  }

  private handleEvent(frame: EventFrame): void {
    const subs = this.eventSubs.get(frame.event);
    if (!subs) return;
    for (const cb of subs) {
      try {
        cb(frame.payload);
      } catch {
        /* subscriber error */
      }
    }
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    for (const cb of this.connSubs) {
      try {
        cb(s);
      } catch {
        /* listener error */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
  }

  private rejectAllPending(reason: string): void {
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

// Singleton instance
export const gateway = new GatewayClient();
