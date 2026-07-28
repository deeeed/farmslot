import { AppState, type AppStateStatus } from 'react-native';

import {
  type EventFrame,
  type Frame,
  type GatewayAuthConnectResult,
  Methods,
  type RequestFrame,
  type ResponseFrame,
} from '@farmslot/protocol';

import { gatewaySupportsPing } from './gateway-connection-test';
import { connectionWaitTerminalError } from './gateway-connection-wait';
import type { GatewayAuthCredentials } from './gateway-http-auth';

export { type GatewayConnectionTestResult, testGatewayConnection } from './gateway-connection-test';
export {
  type GatewayAuthCredentials,
  type GatewayHttpAuthHeaders,
  gatewayHttpAuthHeaders,
} from './gateway-http-auth';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
type EventCallback = (payload: unknown) => void;
type ConnectionCallback = (state: ConnectionState) => void;

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT = 15_000;
const MAX_BACKOFF = 30_000;
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
  private lastConnectionError: string | null = null;
  private pingSupported: boolean | null = null;
  private generation = 0;

  constructor(url: string, auth: GatewayAuthCredentials = {}) {
    this.url = url;
    this.auth = auth;
    this.setupAppStateListener();
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get gatewayPingSupported(): boolean | null {
    return this.pingSupported;
  }

  get connectionGeneration(): number {
    return this.generation;
  }

  setConnection(url: string, auth: GatewayAuthCredentials = {}): void {
    const changed =
      this.url !== url || this.auth.token !== auth.token || this.auth.password !== auth.password;
    this.url = url;
    this.auth = auth;
    if (!changed) return;

    this.generation += 1;
    this.pingSupported = null;
    this.cancelReconnect();
    this.rejectAllPending('Gateway profile changed');
    this.closeCurrentSocket();
    this.setState('disconnected');
    this.backoff = 1000;
    this.connect();
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

    this.cancelReconnect();
    this.lastConnectionError = null;
    this.setState('connecting');
    const socket = new WebSocket(this.url);
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.authenticate().catch((error: Error) => {
        if (this.ws !== socket) return;
        this.lastConnectionError = `Authentication failed: ${error.message}`;
        this.rejectAllPending(this.lastConnectionError);
        socket.close();
      });
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.invalidateTransportCapability();
      if (this.state === 'connecting' && !this.lastConnectionError) {
        this.lastConnectionError = 'Gateway connection closed before authentication completed';
      }
      this.setState('disconnected');
      this.rejectAllPending('Connection closed');
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose fires after onerror
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (this.ws !== socket) return;
      try {
        const frame: Frame = JSON.parse(ev.data as string);
        if (frame.type === 'res') {
          this.handleResponse(frame as ResponseFrame);
        } else if (frame.type === 'event') {
          this.handleEvent(frame as EventFrame);
        }
      } catch (error) {
        this.rejectAllPending(`Malformed gateway frame: ${getErrorMessage(error)}`);
        socket.close();
      }
    };
  }

  reconnect(): void {
    if (this.disposed || this.pausedForBackground) return;
    this.invalidateTransportCapability();
    this.cancelReconnect();
    this.rejectAllPending('Gateway reconnect requested');
    this.closeCurrentSocket();
    this.setState('disconnected');
    this.backoff = 1000;
    this.connect();
  }

  private async authenticate(): Promise<void> {
    const result = await this.request<GatewayAuthConnectResult>(Methods.AUTH_CONNECT, {
      clientKind: 'companion',
      ...this.auth,
    });
    if (!result.ok) throw new Error('Gateway authentication failed');
    this.pingSupported = gatewaySupportsPing(result);
    this.backoff = 1000;
    this.lastConnectionError = null;
    this.setState('connected');
  }

  disconnect(): void {
    this.disposed = true;
    this.cancelReconnect();
    this.pausedForBackground = false;
    this.rejectAllPending('Client disconnected');
    this.closeCurrentSocket();
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
        const detail = this.lastConnectionError ? ` Last error: ${this.lastConnectionError}` : '';
        finish(new Error(`Gateway did not connect within ${timeout}ms.${detail}`));
      }, timeout);

      unsubscribe = this.onConnectionChange((state) => {
        if (state === 'connected') finish();
        if (state === 'disconnected') {
          const terminalError = connectionWaitTerminalError(
            this.pausedForBackground,
            this.lastConnectionError,
          );
          if (terminalError) finish(new Error(terminalError));
        }
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
    this.cancelReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
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

  private cancelReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private closeCurrentSocket(): void {
    const socket = this.ws;
    this.ws = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }

  private invalidateTransportCapability(): void {
    this.generation += 1;
    this.pingSupported = null;
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
      this.invalidateTransportCapability();
      this.cancelReconnect();
      this.rejectAllPending('Gateway paused while app is in the background');
      this.closeCurrentSocket();
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
