import { AppState, type AppStateStatus } from 'react-native';

import {
  type EventFrame,
  Events,
  type Frame,
  type GatewayAuthConnectResult,
  gatewayAuthenticationRefused,
  GatewayRecovery,
  hasAuthErrorCode,
  Methods,
  type PersonDeviceSession,
  PersonSessionClient,
  PersonSessionEndedError,
  type RequestFrame,
  type ResourceObserversReplaceParams,
  type ResourceObserversReplaceResult,
  type ResponseFrame,
  type SelfPrincipalSummary,
} from '@farmslot/protocol';
import {
  requestResourceRead,
  type ResourceConnectionReason,
  type ResourceReadMethod,
  type ResourceReadOptions,
  type ResourceReadResult,
  resourceReadTimeout,
} from '@farmslot/protocol/client-cache';
import {
  isPerformanceMethod,
  measureClientRequest,
  type PerformanceActionClass,
  performanceActionClass,
  PerformanceRecorder,
  PerformanceReporter,
  utf8ByteLength,
} from '@farmslot/protocol/performance';

import { gatewaySupportsPing } from './gateway-connection-test';
import { connectionWaitTerminalError } from './gateway-connection-wait';
import {
  type GatewayAuthCredentials,
  type GatewayHttpAuthHeaders,
  gatewayHttpAuthHeaders,
} from './gateway-http-auth';
import { nativeCollectionReadTimeout } from './gateway-run-sync';
import { createOfflineClientStoreBaseline } from './offline-client-store-baseline';
import { inputSequenceOf, type TerminalInputSequencing } from './terminal-input-queue';
import {
  type WorkspaceAccess,
  workspaceAccessFromAuth,
  workspaceAllowsMethod,
} from './workspace-access';

export {
  type GatewayConnectionTestResult,
  signOutGatewayDevice,
  testGatewayConnection,
} from './gateway-connection-test';
export {
  type GatewayAuthCredentials,
  type GatewayHttpAuthHeaders,
  gatewayHttpAuthHeaders,
} from './gateway-http-auth';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
type EventCallback = (payload: unknown) => void;
type ConnectionCallback = (state: ConnectionState) => void;

interface PendingRequest {
  received?: (bytes: number) => void;
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  includeResourceState?: boolean;
  cleanup?: () => void;
}

export interface GatewayRequestOptions extends ResourceReadOptions {
  /** Recheck caller lifetime after authentication/reconnection waits, before writing the frame. */
  assertCurrent?: () => void;
  /**
   * Called once the request frame is written to the socket. A failure before it means the gateway
   * never got the request; after it, the gateway may have applied it.
   */
  onSent?: () => void;
}

const DEFAULT_TIMEOUT = 15_000;
export class GatewayClient {
  readonly performance = new PerformanceRecorder('companion');
  private readonly performanceReporter = new PerformanceReporter(
    this.performance,
    () =>
      this.lastAuthentication?.capabilities.performanceDiagnostics === 1 &&
      this.ws?.readyState === WebSocket.OPEN,
    (report) => this.request(Methods.GATEWAY_PERFORMANCE_REPORT, report),
  );

  private resourceReason?: ResourceConnectionReason;
  get resourceConnectionReason() {
    return this.resourceReason;
  }
  private lastAuthentication?: GatewayAuthConnectResult;
  get authenticatedConnection(): GatewayAuthConnectResult | undefined {
    return this.lastAuthentication;
  }
  get resourceChanges() {
    return this.lastAuthentication?.capabilities.resourceChanges;
  }
  /** Measurement only; production builds do not allocate or run the byte counter. */
  readonly offlineBaseline =
    typeof __DEV__ !== 'undefined' && __DEV__
      ? createOfflineClientStoreBaseline(() => this.ws?.close(1000, 'Reconnect measurement'))
      : undefined;
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private reqId = 0;
  private pending = new Map<string, PendingRequest>();
  private eventSubs = new Map<string, Set<EventCallback>>();
  private connSubs = new Set<ConnectionCallback>();
  private preparingConnection: object | null = null;
  private readonly heartbeatSubs = new Set<(latencyMs: number, completedAt: number) => void>();
  onHeartbeat(callback: (latencyMs: number, completedAt: number) => void): () => void {
    this.heartbeatSubs.add(callback);
    return () => this.heartbeatSubs.delete(callback);
  }
  private readonly recovery = new GatewayRecovery({
    enabled: () => this.recoveryEnabled,
    connect: () => this.connect(),
    retire: () => {
      this.rejectAllPending('Gateway is unreachable');
      this.closeCurrentSocket();
      this.invalidateTransportCapability();
      this.setState('disconnected');
    },
    canProbe: () => this.pingSupported === true,
    ping: () => this.requestRaw(Methods.GATEWAY_PING, {}, 5000),
    onResponse: (latencyMs, completedAt) => {
      for (const callback of this.heartbeatSubs) {
        try {
          callback(latencyMs, completedAt);
        } catch (error) {
          rethrowAsync(error);
        }
      }
    },
  });
  get recoveryEnabled(): boolean {
    return (
      !this.disposed &&
      !this.pausedForBackground &&
      !this.authRequired &&
      !this.preparingConnection &&
      Boolean(this.url)
    );
  }
  wake(): void {
    this.recovery.wake();
  }
  private url: string;
  private auth: GatewayAuthCredentials;
  private personSession: PersonSessionClient | null = null;
  private authRequired = false;

  get personDeviceSession(): PersonDeviceSession | null {
    return this.personSession?.session ?? null;
  }

  async clearAccountSession(): Promise<void> {
    await this.personSession?.signOut();
    await this.personSession?.dispose();
    this.personSession = null;
    // Offline sign-out changes authority even when the transport state stays disconnected.
    this.setState(this.state, true, 'sign-out');
  }

  get httpAuthHeaders(): GatewayHttpAuthHeaders {
    return this.access === 'none' ? {} : gatewayHttpAuthHeaders(this.auth);
  }

  private configurePersonSession(): void {
    const storage = this.auth.sessionStorage;
    this.personSession = storage
      ? new PersonSessionClient({
          storage,
          request: async (method, params, accessToken) => {
            if (accessToken) await this.acceptAccess(accessToken);
            return this.requestRaw(method, params);
          },
          onAccess: async (grant) => {
            this.auth.token = grant.accessToken;
            delete this.auth.password;
            this.auth.personSessionRequired = true;
            this.auth.explicitPersonSignIn = false;
            if (this.state === 'connected') await this.acceptAccess(grant.accessToken);
          },
        })
      : null;
  }

  private async acceptAccess(token: string): Promise<GatewayAuthConnectResult> {
    const result = await this.requestRaw<GatewayAuthConnectResult>(Methods.AUTH_CONNECT, {
      clientKind: 'companion',
      token,
    });
    this.lastAuthentication = result;
    this.auth.token = token;
    this.principal = result.principal ?? null;
    this.access = workspaceAccessFromAuth(result);
    this.pingSupported = gatewaySupportsPing(result);
    this.inputSequence = inputSequenceOf(result.capabilities?.terminalInputSequence);
    if (this.state === 'connected') this.setState('connected', true);
    return result;
  }
  private disposed = false;
  private pausedForBackground = false;
  /** The socket is closed because the app is in the background, not because of an outage. */
  get backgroundPaused(): boolean {
    return this.pausedForBackground;
  }
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
  private wasConnectedBeforeBackground = false;
  private lastConnectionError: string | null = null;
  private pingSupported: boolean | null = null;
  private inputSequence: TerminalInputSequencing | null = null;
  /** How the gateway types each terminal input sequence number once, or null when it does not. */
  get terminalInputSequence(): TerminalInputSequencing | null {
    return this.inputSequence;
  }
  private generation = 0;
  private principal: SelfPrincipalSummary | null = null;
  private access: WorkspaceAccess = 'none';

  get authenticatedPrincipal(): SelfPrincipalSummary | null {
    return this.principal;
  }
  get workspaceAccess(): WorkspaceAccess {
    return this.access;
  }

  constructor(url: string, auth: GatewayAuthCredentials = {}) {
    this.url = url;
    this.auth = auth;
    this.configurePersonSession();
    this.setupAppStateListener();
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get gatewayUrl(): string {
    return this.url;
  }

  get gatewayPingSupported(): boolean | null {
    return this.pingSupported;
  }

  get connectionGeneration(): number {
    return this.generation;
  }

  async setConnection(
    url: string,
    auth: GatewayAuthCredentials = {},
    force = false,
    reason?: ResourceConnectionReason,
  ): Promise<void> {
    const resourceReason = reason ?? (this.url !== url ? 'profile-change' : 'principal-change');
    const changed =
      force ||
      this.url !== url ||
      this.auth.token !== auth.token ||
      this.auth.password !== auth.password ||
      this.auth.sessionStorage !== auth.sessionStorage;
    this.url = url;
    this.auth = auth;
    if (!changed) return;

    const preparation = {};
    this.preparingConnection = preparation;
    const previousSession = this.personSession;
    this.personSession = null;
    this.generation += 1;
    this.authRequired = false;
    this.pingSupported = null;
    this.inputSequence = null;
    this.clearAuthority();
    this.cancelReconnect();
    this.rejectAllPending('Gateway profile changed');
    this.closeCurrentSocket();
    this.setState('disconnected', true, resourceReason);
    try {
      if (previousSession) await previousSession.dispose();
      if (this.preparingConnection !== preparation || this.disposed) return;
      this.configurePersonSession();
    } finally {
      if (this.preparingConnection === preparation) this.preparingConnection = null;
    }
    this.connect();
  }

  setUrl(url: string): void {
    const pending = this.setConnection(url, this.auth);
    const generation = this.generation;
    pending.catch((error: unknown) => {
      if (generation !== this.generation) return;
      this.lastConnectionError = getErrorMessage(error);
      this.clearAuthority();
      this.setState('disconnected', true);
    });
  }

  connect(): void {
    if (this.disposed || this.pausedForBackground || this.authRequired || this.preparingConnection)
      return;
    if (!this.url) {
      this.setState('disconnected');
      return;
    }
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    )
      return;

    this.lastConnectionError = null;
    this.setState('connecting');
    const socket = new WebSocket(this.url);
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.authenticate(socket, this.generation).catch((error: Error) => {
        if (this.ws !== socket) return;
        this.authRequired = gatewayAuthenticationRefused(error);
        if (this.authRequired) this.clearAuthority();
        this.resourceReason = hasAuthErrorCode(error, 'AUTH_SESSION_ENDED')
          ? 'session-ended'
          : this.authRequired
            ? 'credential-refused'
            : 'network';
        this.lastConnectionError = `Authentication failed: ${error.message}`;
        this.rejectAllPending(this.lastConnectionError);
        socket.close();
      });
    };

    socket.onclose = (event) => {
      if (this.ws !== socket) return;
      this.offlineBaseline?.begin('reconnect');
      if (event.code === 1008) this.clearAuthority();
      this.ws = null;
      this.personSession?.stopRefresh();
      this.invalidateTransportCapability();
      if (this.state === 'connecting' && !this.lastConnectionError) {
        this.lastConnectionError = 'Gateway connection closed before authentication completed';
      }
      this.setState('disconnected', false, this.authRequired ? this.resourceReason : 'network');
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
        if (frame.type === 'res' || frame.type === 'event')
          this.offlineBaseline?.received(ev.data as string, frame);
        if (frame.type === 'res') {
          this.handleResponse(frame as ResponseFrame, utf8ByteLength(ev.data as string));
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
    this.connect();
  }

  private async authenticate(socket: WebSocket, generation: number): Promise<void> {
    const session = this.personSession;
    if (session) await session.restore();
    if (this.ws !== socket || this.generation !== generation) return;
    let result: GatewayAuthConnectResult;
    if (session?.session) {
      await session.accessToken(true);
      result = await session.withAccess((token) => this.acceptAccess(token));
    } else {
      if (this.auth.personSessionRequired && !this.auth.explicitPersonSignIn)
        throw new PersonSessionEndedError();
      try {
        result = await this.requestRaw<GatewayAuthConnectResult>(Methods.AUTH_CONNECT, {
          clientKind: 'companion',
          token: this.auth.token,
          password: this.auth.password,
        });
      } catch (error) {
        if (!hasAuthErrorCode(error, 'AUTH_PERSON_SESSION_REQUIRED')) throw error;
        if (this.auth.explicitPersonSignIn && this.auth.token && session) {
          await session.exchange({
            credential: this.auth.token,
            deviceName: 'Mobile Companion',
            deviceKind: 'companion',
          });
          result = await session.withAccess((token) => this.acceptAccess(token));
        } else {
          await this.auth.sessionStorage?.save(null);
          delete this.auth.token;
          delete this.auth.password;
          this.auth.personSessionRequired = true;
          throw error;
        }
      }
      if (result.principal?.subjectKind === 'person' && !session?.session) {
        if (!this.auth.explicitPersonSignIn) await this.auth.sessionStorage?.save(null);
        throw new PersonSessionEndedError();
      }
    }
    if (this.ws !== socket || this.generation !== generation) return;
    this.lastAuthentication = result;
    this.principal = result.principal ?? null;
    this.access = workspaceAccessFromAuth(result);
    this.pingSupported = gatewaySupportsPing(result);
    this.inputSequence = inputSequenceOf(result.capabilities?.terminalInputSequence);
    this.lastConnectionError = null;
    this.setState('connected');
    if (session?.session)
      session.startRefresh((error) => {
        if (this.personSession !== session) return;
        this.failPersonRefresh(error);
      });
  }

  private failPersonRefresh(error: unknown): void {
    this.lastConnectionError = getErrorMessage(error);
    this.authRequired = hasAuthErrorCode(error, 'AUTH_SESSION_ENDED');
    if (this.authRequired) this.clearAuthority();
    this.rejectAllPending(this.lastConnectionError);
    this.closeCurrentSocket();
    this.setState('disconnected', true, this.authRequired ? 'session-ended' : 'network');
    if (!this.authRequired) this.scheduleReconnect();
  }

  disconnect(): void {
    this.disposed = true;
    this.recovery.dispose();
    this.heartbeatSubs.clear();
    this.personSession?.stopRefresh();
    this.cancelReconnect();
    this.pausedForBackground = false;
    this.clearAuthority();
    this.generation += 1;
    this.rejectAllPending('Client disconnected');
    this.closeCurrentSocket();
    this.setState(
      'disconnected',
      false,
      this.resourceReason === 'sign-out' ? 'sign-out' : 'network',
    );
    this.performanceReporter.dispose();
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeout: number | null = DEFAULT_TIMEOUT,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    if (options?.signal?.aborted) throw new Error('Resource read aborted');
    options?.assertCurrent?.();
    if (this.personSession?.session && !isAuthenticationEntry(method)) {
      const person = this.personSession;
      try {
        return await person.withAccess(async (token) => {
          options?.assertCurrent?.();
          if (this.auth.token !== token) await this.acceptAccess(token);
          return this.requestRaw<T>(method, params, timeout, options);
        });
      } catch (error) {
        if (person === this.personSession && hasAuthErrorCode(error, 'AUTH_SESSION_ENDED'))
          this.failPersonRefresh(error);
        throw error;
      }
    }
    return this.requestRaw<T>(method, params, timeout, options);
  }

  requestResource<T>(
    method: ResourceReadMethod,
    params: unknown,
    signal?: AbortSignal,
    performanceClass?: PerformanceActionClass,
  ): Promise<ResourceReadResult<T>> {
    return requestResourceRead<T>(method, params, <Reply>(observed: boolean) =>
      this.request<Reply>(
        method,
        params,
        nativeCollectionReadTimeout(method, params) ??
          resourceReadTimeout(method) ??
          DEFAULT_TIMEOUT,
        {
          performanceClass,
          includeResourceState: observed,
          signal,
        },
      ),
    );
  }

  replaceResourceObservers(
    params: ResourceObserversReplaceParams,
    signal?: AbortSignal,
  ): Promise<ResourceObserversReplaceResult> {
    return this.request(Methods.RESOURCE_OBSERVERS_REPLACE, params, DEFAULT_TIMEOUT, { signal });
  }

  private async requestRaw<T = unknown>(
    method: string,
    params?: unknown,
    timeout: number | null = DEFAULT_TIMEOUT,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    if (isPerformanceMethod(method))
      return this.requestRawUnmeasured<T>(method, params, timeout, options);
    try {
      return await measureClientRequest(
        this.performance,
        method,
        options?.performanceClass ?? performanceActionClass(method),
        (received) => this.requestRawUnmeasured<T>(method, params, timeout, options, received),
      );
    } finally {
      this.performanceReporter.schedule();
    }
  }

  private async requestRawUnmeasured<T = unknown>(
    method: string,
    params?: unknown,
    timeout: number | null = DEFAULT_TIMEOUT,
    options?: GatewayRequestOptions,
    received?: (bytes: number) => void,
  ): Promise<T> {
    if (options?.signal?.aborted) throw new Error('Resource read aborted');
    const generation = this.generation;
    if (!isAuthenticationEntry(method) && this.state !== 'connected') {
      await this.waitForConnected(timeout ?? DEFAULT_TIMEOUT, options?.signal);
    }

    if (generation !== this.generation) throw new Error('Gateway identity changed before request');
    if (options?.signal?.aborted) throw new Error('Resource read aborted');
    if (!workspaceAllowsMethod(this.access, method, params))
      throw new Error('This account cannot access farm controls');

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }

    options?.assertCurrent?.();

    const id = String(++this.reqId);
    const frame: RequestFrame = {
      type: 'req',
      id,
      method,
      params,
      ...(options?.includeResourceState ? { resourceRead: { version: 1 as const } } : {}),
    };

    const result = await new Promise<T>((resolve, reject) => {
      const cleanup = () => options?.signal?.removeEventListener('abort', abort);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        cleanup();
        reject(new Error('Resource read aborted'));
      };
      const timer =
        timeout === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              cleanup();
              reject(new Error(`Request ${method} timed out after ${timeout}ms`));
            }, timeout);

      this.pending.set(id, {
        received,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        includeResourceState: options?.includeResourceState,
        cleanup,
      });
      options?.signal?.addEventListener('abort', abort, { once: true });

      this.offlineBaseline?.sent(frame);
      this.ws!.send(JSON.stringify(frame));
      options?.onSent?.();
    });
    if (generation !== this.generation) throw new Error('Gateway identity changed during request');
    return result;
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

  private waitForConnected(timeout: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('Resource read aborted'));
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
        signal?.removeEventListener('abort', abort);
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
      const abort = () => finish(new Error('Resource read aborted'));
      signal?.addEventListener('abort', abort, { once: true });

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

  private handleResponse(frame: ResponseFrame, bytes: number): void {
    const req = this.pending.get(frame.id);
    if (!req) return;
    req.received?.(bytes);
    this.pending.delete(frame.id);
    clearTimeout(req.timer);
    req.cleanup?.();

    if (frame.ok) {
      req.resolve(
        req.includeResourceState
          ? { data: frame.payload, resourceState: frame.resourceState }
          : frame.payload,
      );
    } else {
      req.reject(Object.assign(new Error(frame.error?.message ?? 'Unknown error'), frame.error));
    }
  }

  private handleEvent(frame: EventFrame): void {
    if (
      this.state !== 'connected' ||
      (this.access !== 'farm' && frame.event !== Events.RESOURCE_CHANGED)
    )
      return;
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

  private setState(
    s: ConnectionState,
    authorityChanged = false,
    reason?: ResourceConnectionReason,
  ): void {
    this.recovery.update(s);
    if (this.state === s && !authorityChanged && this.resourceReason === reason) return;
    this.resourceReason = reason;
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
    this.recovery.update('disconnected');
  }

  private rejectAllPending(reason: string): void {
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.cleanup?.();
      req.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private cancelReconnect(): void {
    this.recovery.reset();
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
    this.inputSequence = null;
  }

  private clearAuthority(): void {
    this.lastAuthentication = undefined;
    this.principal = null;
    this.access = 'none';
  }

  private setupAppStateListener(): void {
    this.pausedForBackground =
      AppState.currentState === 'background' || AppState.currentState === 'inactive';
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
      if (this.wasConnectedBeforeBackground || this.state === 'disconnected') this.connect();
      this.wake();
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

function isAuthenticationEntry(method: string): boolean {
  return (
    method === Methods.AUTH_CONNECT ||
    method === Methods.AUTH_SESSION_EXCHANGE ||
    method === Methods.AUTH_SESSION_REFRESH
  );
}
