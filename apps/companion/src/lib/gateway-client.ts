import { AppState, type AppStateStatus } from 'react-native';

import {
  type EventFrame,
  type Frame,
  type GatewayAuthConnectResult,
  Methods,
  type RequestFrame,
  type ResponseFrame,
} from '@farmslot/protocol';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
type EventCallback = (payload: unknown) => void;
type ConnectionCallback = (state: ConnectionState) => void;

export interface GatewayAuthCredentials {
  token?: string;
  password?: string;
}

export type GatewayHttpAuthHeaders = Record<string, string>;

export function gatewayHttpAuthHeaders(auth: GatewayAuthCredentials = {}): GatewayHttpAuthHeaders {
  const credential = auth.token?.trim() || auth.password?.trim();
  return credential ? { Authorization: `Bearer ${credential}` } : {};
}

export interface GatewayConnectionTestResult extends GatewayAuthConnectResult {
  latencyMs: number;
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT = 15_000;
const MAX_BACKOFF = 30_000;
const CONNECTION_TEST_TIMEOUT = 8_000;

export function testGatewayConnection(
  url: string,
  auth: GatewayAuthCredentials = {},
  timeout = CONNECTION_TEST_TIMEOUT,
): Promise<GatewayConnectionTestResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      finishWithError(new Error(`Gateway connection test timed out after ${timeout}ms`));
    }, timeout);

    const finish = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      return true;
    };

    const finishWithError = (error: Error) => {
      if (!finish()) return;
      reject(error);
    };

    ws.onopen = () => {
      const frame: RequestFrame = {
        type: 'req',
        id: 'connection-test',
        method: Methods.AUTH_CONNECT,
        params: {
          clientKind: 'companion',
          ...auth,
        },
      };
      ws.send(JSON.stringify(frame));
    };

    ws.onmessage = (ev: MessageEvent) => {
      let frame: Frame;
      try {
        frame = JSON.parse(ev.data as string) as Frame;
      } catch (error) {
        finishWithError(new Error(`Gateway returned malformed JSON: ${getErrorMessage(error)}`));
        return;
      }
      if (frame.type !== 'res' || frame.id !== 'connection-test') return;
      const response = frame as ResponseFrame;
      if (!response.ok) {
        finishWithError(new Error(response.error?.message ?? 'Gateway authentication failed'));
        return;
      }
      if (!finish()) return;
      resolve({
        ...(response.payload as GatewayAuthConnectResult),
        latencyMs: Date.now() - startedAt,
      });
    };

    ws.onerror = () => {
      finishWithError(new Error('Gateway socket error during connection test'));
    };

    ws.onclose = () => {
      if (settled) return;
      finishWithError(new Error('Gateway closed before authentication completed'));
    };
  });
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private reqId = 0;
  private pending = new Map<string, PendingRequest>();
  private eventSubs = new Map<string, Set<EventCallback>>();
  private connSubs = new Set<ConnectionCallback>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private url: string;
  private auth: GatewayAuthCredentials;
  private disposed = false;
  private pausedForBackground = false;
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
  private wasConnectedBeforeBackground = false;

  constructor(url: string, auth: GatewayAuthCredentials = {}) {
    this.url = url;
    this.auth = auth;
    this.setupAppStateListener();
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  setConnection(url: string, auth: GatewayAuthCredentials = {}): void {
    const changed =
      this.url !== url || this.auth.token !== auth.token || this.auth.password !== auth.password;
    this.url = url;
    this.auth = auth;
    if (changed && this.state !== 'disconnected') {
      this.ws?.close();
      this.connect();
    }
  }

  setUrl(url: string): void {
    this.setConnection(url, this.auth);
  }

  connect(): void {
    if (this.disposed || this.pausedForBackground) return;
    if (!this.url) {
      this.setState('disconnected');
      return;
    }
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    )
      return;

    this.setState('connecting');
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.authenticate().catch((error: Error) => {
        this.rejectAllPending(`Authentication failed: ${error.message}`);
        this.ws?.close();
      });
    };

    this.ws.onclose = () => {
      this.setState('disconnected');
      this.rejectAllPending('Connection closed');
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose fires after onerror
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      try {
        const frame: Frame = JSON.parse(ev.data as string);
        if (frame.type === 'res') {
          this.handleResponse(frame as ResponseFrame);
        } else if (frame.type === 'event') {
          this.handleEvent(frame as EventFrame);
        }
      } catch (error) {
        this.rejectAllPending(`Malformed gateway frame: ${getErrorMessage(error)}`);
        this.ws?.close();
      }
    };
  }

  private async authenticate(): Promise<void> {
    const result = await this.request<GatewayAuthConnectResult>(Methods.AUTH_CONNECT, {
      clientKind: 'companion',
      ...this.auth,
    });
    if (!result.ok) throw new Error('Gateway authentication failed');
    this.backoff = 1000;
    this.setState('connected');
  }

  disconnect(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pausedForBackground = false;
    this.rejectAllPending('Client disconnected');
    this.ws?.close();
    this.ws = null;
    this.setState('disconnected');
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeout = DEFAULT_TIMEOUT,
  ): Promise<T> {
    if (method !== Methods.AUTH_CONNECT && this.state !== 'connected') {
      await this.waitForConnected(timeout);
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }

    const id = String(++this.reqId);
    const frame: RequestFrame = { type: 'req', id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeout}ms`));
      }, timeout);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  subscribe(event: string, callback: EventCallback): () => void {
    let set = this.eventSubs.get(event);
    if (!set) {
      set = new Set();
      this.eventSubs.set(event, set);
    }
    set.add(callback);

    return () => {
      set!.delete(callback);
      if (set!.size === 0) this.eventSubs.delete(event);
    };
  }

  onConnectionChange(callback: ConnectionCallback): () => void {
    this.connSubs.add(callback);
    return () => {
      this.connSubs.delete(callback);
    };
  }

  private waitForConnected(timeout: number): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Client disconnected'));
    if (this.pausedForBackground) {
      return Promise.reject(new Error('Gateway paused while app is in the background'));
    }
    if (this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    this.connect();

    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | null = null;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      const timer = setTimeout(() => {
        finish(new Error(`Gateway did not connect within ${timeout}ms`));
      }, timeout);

      unsubscribe = this.onConnectionChange((state) => {
        if (state === 'connected') finish();
      });

      if (this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN) finish();
    });
  }

  private handleResponse(frame: ResponseFrame): void {
    const req = this.pending.get(frame.id);
    if (!req) return;
    this.pending.delete(frame.id);
    clearTimeout(req.timer);

    if (frame.ok) {
      req.resolve(frame.payload);
    } else {
      req.reject(new Error(frame.error?.message ?? 'Unknown error'));
    }
  }

  private handleEvent(frame: EventFrame): void {
    const subs = this.eventSubs.get(frame.event);
    if (!subs) return;
    for (const cb of subs) {
      try {
        cb(frame.payload);
      } catch (error) {
        rethrowAsync(error);
      }
    }
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    for (const cb of this.connSubs) {
      try {
        cb(s);
      } catch (error) {
        rethrowAsync(error);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.pausedForBackground) return;
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

  private setupAppStateListener(): void {
    this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange);
  }

  private handleAppStateChange = (nextState: AppStateStatus): void => {
    if (nextState === 'background' || nextState === 'inactive') {
      // Pause the socket while backgrounded without marking the client as
      // permanently disposed. Pending view requests should resume on foreground
      // instead of leaving workspace screens stuck with a stale client.
      this.wasConnectedBeforeBackground = this.state !== 'disconnected';
      this.pausedForBackground = true;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.setState('disconnected');
    } else if (nextState === 'active') {
      this.pausedForBackground = false;
      if (this.wasConnectedBeforeBackground || this.state === 'disconnected') {
        this.connect();
      }
    }
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rethrowAsync(error: unknown): void {
  setTimeout(() => {
    throw error instanceof Error ? error : new Error(String(error));
  }, 0);
}
