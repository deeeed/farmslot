// WebSocket client for Farmslot gateway — request/response + event subscription

import type {
  EventFrame,
  Frame,
  GatewayAuthConnectResult,
  PersonDeviceSession,
  RequestFrame,
  ResponseFrame,
  SelfPrincipalSummary,
} from '@farmslot/protocol';
import {
  hasAuthErrorCode,
  Methods,
  parsePersonSessionToken,
  PersonSessionClient,
  PersonSessionEndedError,
  signOutAccount,
  workspaceAccessFromAuth,
} from '@farmslot/protocol';

import {
  getDesktopConnection,
  isDesktopClient,
  saveDesktopCredentials,
} from './desktop-connection.js';
import {
  createIdleRequestTimeout,
  type GatewayRequestOptions,
  GatewayRequestTimeoutError,
  normalizeGatewayRequestOptions,
} from './gateway-request-timeout.js';
import {
  clearGatewayMemoryAuth,
  filterConnectableGatewayUrls,
  GATEWAY_CANDIDATES_STORAGE_KEY,
  GATEWAY_SESSION_EXPIRY_STORAGE_KEY,
  GATEWAY_SIGNED_OUT_STORAGE_KEY,
  GATEWAY_SOURCE_STORAGE_KEY,
  GATEWAY_URL_STORAGE_KEY,
  gatewayWebSocketToHttpOrigin,
  parseHostedGatewayConnection,
  readStoredGatewayAuth,
  replaceStoredGatewayAuthForHttp,
  resolveGatewayConnectionSource,
  resolveGatewayWebSocketUrls,
  setGatewayMemoryAuth,
} from './gateway-url.js';
import { CommandCenterPersonSessionStorage } from './person-session-storage.js';

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

interface BrowserGatewayConnection {
  urls: string[];
  auth: GatewayAuthCredentials;
  source: 'configured' | 'hosted' | 'stored' | 'implicit';
  explicit?: boolean;
  code?: string;
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
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

/**
 * Copy shown while the UI is waiting to reach a genuinely-down gateway (http origin, or a
 * reachable wss endpoint). Names the endpoint and teaches the escape so an install-time
 * connection race is not mistaken for a failure.
 */
export function gatewayWaitingMessage(gatewayUrl: string): string {
  return `Waiting for gateway on ${gatewayUrl} — if this persists: run \`farmslot up\`, then check ~/.farmslot/gateway.log`;
}

/**
 * Copy shown when the browser itself is blocking the local gateway as mixed content (an
 * insecure ws:// endpoint reached from an https origin). Chrome 150's per-site "Insecure
 * content = Allow" setting does NOT unblock this (verified: ws:// still closes 1006). The
 * easy escape is now a locally-trusted TLS cert so the gateway serves wss:// (`farmslot certs
 * setup`); serving the UI from a local http origin remains a fallback.
 */
export function gatewayInsecureBlockedMessage(): string {
  return [
    "This page can't reach a local ws:// gateway (browser policy). One-time fix: run `farmslot certs setup` (installs a local TLS cert), then `farmslot up`, then reload this page — the gateway will be reachable over wss://. (mkcert required: `brew install mkcert`.)",
    'Fallback: serve the UI from a local http origin instead (build the ui, serve dist over http) with the same #connect payload.',
  ].join('\n');
}

/**
 * Pick the disconnected-state copy: the mixed-content explanation when the browser is blocking
 * every candidate, otherwise the "gateway is genuinely down" teaching. These are different
 * states with different fixes.
 */
export function gatewayStatusMessage(client: {
  gatewayUrl: string;
  insecureContentBlocked: boolean;
}): string {
  return client.insecureContentBlocked
    ? gatewayInsecureBlockedMessage()
    : gatewayWaitingMessage(client.gatewayUrl);
}

const DEFAULT_TIMEOUT = 15_000;
const MAX_BACKOFF = 30_000;
const HTTP_AUTH_COOKIE = 'farmslot_gateway_credential';
const HTTP_PASSWORD_COOKIE = 'farmslot_gateway_password';

function resolveBrowserGatewayConnection(): BrowserGatewayConnection {
  if (isDesktopClient()) {
    const connection = getDesktopConnection();
    if (!connection) throw new Error('Desktop connection has not been initialized.');
    return {
      urls: [connection.url],
      auth: { token: connection.token, password: connection.password },
      source: 'configured',
      explicit: connection.pending === true,
    };
  }
  const env = (import.meta as ImportMetaWithEnv).env ?? {};
  const storedAuth = readStoredGatewayAuth();
  const hosted = parseHostedGatewayConnection(location.hash);
  const signedOut = localStorage.getItem(GATEWAY_SIGNED_OUT_STORAGE_KEY) === 'true';
  const token = signedOut ? undefined : (hosted.token ?? storedAuth.token);
  const password = signedOut ? undefined : (hosted.password ?? storedAuth.password);
  const storedCandidates = localStorage.getItem(GATEWAY_CANDIDATES_STORAGE_KEY);
  const storedGatewayUrl = localStorage.getItem(GATEWAY_URL_STORAGE_KEY);
  const storedSource = localStorage.getItem(GATEWAY_SOURCE_STORAGE_KEY);
  const urls = resolveGatewayWebSocketUrls(
    env.VITE_FARMSLOT_GATEWAY_URL,
    location,
    storedCandidates,
    storedGatewayUrl,
  );
  const source = resolveGatewayConnectionSource(
    env.VITE_FARMSLOT_GATEWAY_URL,
    location,
    storedCandidates,
    storedGatewayUrl,
    storedSource,
  );
  return {
    urls,
    source,
    explicit: Boolean(hosted.code || hosted.token || hosted.password),
    code: hosted.code,
    auth: {
      ...(token ? { token } : {}),
      ...(password ? { password } : {}),
    },
  };
}

function syncBrowserHttpAuthCookie(auth: GatewayAuthCredentials, gatewayUrl: string): void {
  if (isDesktopClient()) return;
  const token = auth.token?.trim();
  const password = auth.password?.trim();
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  const clearCookies = (): void => {
    for (const name of [HTTP_AUTH_COOKIE, HTTP_PASSWORD_COOKIE]) {
      document.cookie = `${name}=; Path=/; SameSite=Lax; Max-Age=0${secure}`;
    }
  };
  if ((!token && !password) || (token && parsePersonSessionToken(token, 'fsa'))) {
    clearCookies();
    return;
  }
  const maxAge = 30 * 24 * 60 * 60;
  try {
    if (gatewayWebSocketToHttpOrigin(gatewayUrl) !== location.origin) {
      clearCookies();
      return;
    }
  } catch {
    clearCookies();
    return;
  }
  clearCookies();
  const name = token ? HTTP_AUTH_COOKIE : HTTP_PASSWORD_COOKIE;
  const credential = token ?? password;
  document.cookie = `${name}=${encodeURIComponent(
    credential!,
  )}; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private wsAbort: AbortController | null = null;
  private state: ConnectionState = 'disconnected';
  private epoch = 0;
  private principal: SelfPrincipalSummary | null = null;
  private adminRole = false;
  private access: 'farm' | 'native' | 'none' = 'none';
  private reqId = 0;
  private pending = new Map<string, PendingRequest>();
  private eventSubs = new Map<string, Set<EventCallback>>();
  private connSubs = new Set<ConnectionCallback>();
  private binarySubs = new Set<BinaryCallback>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private urls: string[];
  private urlIndex = 0;
  private url: string;
  private auth: GatewayAuthCredentials;
  private source: BrowserGatewayConnection['source'];
  private disposed = false;
  private personStorage: CommandCenterPersonSessionStorage;
  private person: PersonSessionClient;
  private explicitSignIn: boolean;
  private rememberMe?: boolean;
  private pairingCode?: string;
  private authBlocked = false;

  get personSession(): PersonDeviceSession | null {
    return this.person.session;
  }

  private createPersonClient(): PersonSessionClient {
    return new PersonSessionClient({
      storage: this.personStorage,
      request: (method, params) => this.rawRequest(method, params),
      onAccess: async (grant) => {
        const socket = this.ws;
        const result = await this.rawRequest<GatewayAuthConnectResult>(Methods.AUTH_CONNECT, {
          clientKind: 'ui',
          token: grant.accessToken,
        });
        if (!socket || socket !== this.ws || this.disposed)
          throw new Error('Gateway connection changed during sign-in.');
        if (
          result.principal?.subjectKind !== 'person' ||
          result.principal.id !== grant.session.principalId
        )
          throw new Error('The gateway did not verify this person sign-in.');
        await this.personStorage.commit();
        if (socket !== this.ws || this.disposed)
          throw new Error('Gateway connection changed during sign-in.');
        replaceStoredGatewayAuthForHttp({});
        this.auth = { token: grant.accessToken };
        setGatewayMemoryAuth(this.auth, this.url, this.person);
        syncBrowserHttpAuthCookie({}, this.url);
        this.acceptAuthentication(result);
      },
    });
  }

  private insecureBlocked = false;
  private lastAuthError: GatewayRequestError | null = null;

  constructor(url?: string, auth?: GatewayAuthCredentials) {
    const resolved = resolveBrowserGatewayConnection();
    const candidates = url ? [url] : resolved.urls;
    const { connectable, blocked } = filterConnectableGatewayUrls(candidates, location);
    for (const blockedUrl of blocked) {
      console.info(
        `[gateway] skipping ${blockedUrl}: insecure WebSocket blocked from HTTPS origin`,
      );
    }
    // Every candidate is an insecure ws:// the browser refuses from this https origin: there
    // is nothing to reach until the user unblocks the site or opens the CC from a local origin.
    this.insecureBlocked = connectable.length === 0 && blocked.length > 0;
    // Keep the original candidates for display (gatewayUrl) even when all are blocked.
    this.urls = connectable.length > 0 ? connectable : candidates;
    this.url = this.urls[0];
    this.auth = auth ?? resolved.auth;
    this.source = url ? 'configured' : resolved.source;
    this.explicitSignIn = Boolean(auth) || resolved.explicit === true;
    this.pairingCode = resolved.code;
    if (this.pairingCode) localStorage.removeItem(GATEWAY_SIGNED_OUT_STORAGE_KEY);
    this.personStorage = new CommandCenterPersonSessionStorage(this.urls);
    if (this.explicitSignIn) this.personStorage.beginValidation();
    this.person = this.createPersonClient();
    // Desktop settings return a newly saved credential after sign-out.
    if (isDesktopClient() && (this.auth.token || this.auth.password)) {
      localStorage.removeItem(GATEWAY_SIGNED_OUT_STORAGE_KEY);
    }
    if (localStorage.getItem(GATEWAY_SIGNED_OUT_STORAGE_KEY) === 'true') {
      this.authBlocked = true;
      this.state = 'auth_required';
    }
    this.persistConnection();
    if (resolved.explicit && typeof history !== 'undefined') {
      const raw = location.hash.slice(1);
      const split = raw.indexOf('?');
      const route = split < 0 ? '' : raw.slice(0, split);
      const query = new URLSearchParams(split < 0 ? raw : raw.slice(split + 1));
      query.delete('connect');
      history.replaceState(null, '', `#${route}${query.size ? `?${query}` : ''}`);
    }
    setGatewayMemoryAuth({}, this.url);
    syncBrowserHttpAuthCookie({}, this.url);
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get authenticatedPrincipalId(): string | null {
    return this.authenticatedPrincipal?.id ?? null;
  }

  get authenticatedPrincipal(): SelfPrincipalSummary | null {
    return this.state === 'connected' ? this.principal : null;
  }

  get isGlobalAdmin(): boolean {
    return this.state === 'connected' && this.adminRole;
  }

  get workspaceAccess(): 'farm' | 'native' | 'none' {
    return this.state === 'connected' ? this.access : 'none';
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

  /**
   * True when the only gateway candidates are insecure ws:// endpoints the browser refuses
   * from this https origin (mixed content). This is a dead end until the user unblocks the
   * site or opens the CC from a local origin — not a transient "gateway is down" state.
   */
  get insecureContentBlocked(): boolean {
    return this.insecureBlocked;
  }

  get authCredentialKind(): 'token' | 'password' | 'none' {
    if (this.auth.token) return 'token';
    if (this.auth.password) return 'password';
    return 'none';
  }

  async setAuthCredentials(auth: GatewayAuthCredentials, rememberMe?: boolean): Promise<void> {
    await this.person.restore();
    if (this.person.session) throw new Error('Sign out this device before switching accounts.');
    await saveDesktopCredentials(auth, rememberMe, true);
    await this.person.dispose();
    this.personStorage = new CommandCenterPersonSessionStorage(this.urls);
    this.personStorage.beginValidation();
    this.person = this.createPersonClient();
    this.rememberMe = rememberMe;
    this.auth = auth;
    setGatewayMemoryAuth({}, this.url);
    syncBrowserHttpAuthCookie({}, this.url);
    this.explicitSignIn = true;
    this.pairingCode = undefined;
    localStorage.removeItem(GATEWAY_SIGNED_OUT_STORAGE_KEY);
    this.authBlocked = false;
    this.lastAuthError = null;
    this.rejectAllPending('Gateway credentials changed');
    this.teardownSocket();
    this.setState('disconnected');
  }

  async signedInDevices(): Promise<PersonDeviceSession[]> {
    return this.person.list();
  }

  async revokeDevice(sessionId: string): Promise<void> {
    const current = this.person.session?.id === sessionId;
    await this.person.revoke(sessionId);
    if (current) await this.signOut();
  }

  async signOut(): Promise<void> {
    await this.person.signOut();
    await signOutAccount({
      forgetLogin: async () => {
        await saveDesktopCredentials({});
        localStorage.removeItem(GATEWAY_SESSION_EXPIRY_STORAGE_KEY);
        replaceStoredGatewayAuthForHttp({});
        localStorage.setItem(GATEWAY_SIGNED_OUT_STORAGE_KEY, 'true');
      },
      closeSession: () => {
        this.person.stopRefresh();
        this.auth = {};
        clearGatewayMemoryAuth();
        syncBrowserHttpAuthCookie({}, this.url);
        this.authBlocked = true;
        this.lastAuthError = null;
        this.epoch += 1;
        this.principal = null;
        this.adminRole = false;
        this.access = 'none';
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.rejectAllPending('Signed out');
        this.teardownSocket();
        this.setState('auth_required');
      },
    });
  }

  connect(): void {
    if (this.disposed) return;
    if (this.authBlocked) {
      this.setState('auth_required');
      return;
    }
    // No reachable candidate from this https origin — don't open a doomed socket or spin a
    // retry loop; stay disconnected so the UI can surface the mixed-content explanation.
    if (this.insecureBlocked) {
      this.setState('disconnected');
      return;
    }
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    )
      return;

    // Drop any stale socket and its listeners before opening a new one, so reconnect
    // attempts never accumulate handlers or fire callbacks from an already-dead socket.
    this.teardownSocket();

    this.authBlocked = false;
    this.setState('connecting');

    const ws = new WebSocket(this.url);
    const abort = new AbortController();
    const listenerOptions = { signal: abort.signal };
    this.ws = ws;
    this.wsAbort = abort;
    ws.binaryType = 'arraybuffer';

    ws.addEventListener(
      'open',
      () => {
        this.authenticate(ws).catch((err: Error) => {
          if (this.ws !== ws || this.disposed || this.authBlocked) return;
          if (
            !(err instanceof GatewayRequestError) &&
            !(err instanceof PersonSessionEndedError) &&
            ws.readyState !== WebSocket.OPEN
          ) {
            // Deploys can close the socket while auth.connect is pending. Retry with the saved login.
            ws.close();
            return;
          }
          const authError =
            err instanceof GatewayRequestError
              ? err
              : new GatewayRequestError(
                  err.message,
                  err instanceof PersonSessionEndedError ? err.code : 'AUTH_FAILED',
                );
          this.authBlocked = true;
          this.lastAuthError = authError;
          this.rejectAllPending(`Authentication failed: ${authError.message}`);
          this.setState('auth_required');
          this.ws?.close();
        });
      },
      listenerOptions,
    );

    ws.addEventListener(
      'close',
      () => {
        // Ignore a late close from a socket we have already replaced.
        if (this.ws !== ws) return;
        this.rejectAllPending('Connection closed');
        if (this.authBlocked) {
          this.setState('auth_required');
          return;
        }
        this.setState('disconnected');
        this.advanceGatewayCandidate();
        this.scheduleReconnect();
      },
      listenerOptions,
    );

    // onclose fires after onerror; the error listener only exists to keep the socket quiet.
    ws.addEventListener('error', () => {}, listenerOptions);

    ws.addEventListener(
      'message',
      (ev) => {
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
      },
      listenerOptions,
    );
  }

  private teardownSocket(): void {
    if (this.wsAbort) {
      this.wsAbort.abort();
      this.wsAbort = null;
    }
    if (this.ws) {
      const stale = this.ws;
      this.ws = null;
      try {
        stale.close();
      } catch {
        /* already closing or closed */
      }
    }
  }

  private async authenticate(socket: WebSocket): Promise<void> {
    await this.person.restore();
    if (this.ws !== socket || this.disposed) return;
    if (this.person.session) {
      await this.person.accessToken(true);
      this.person.startRefresh((error) => this.failPersonRefresh(error));
      return;
    }
    if (this.pairingCode) {
      await this.person.exchange({
        code: this.pairingCode,
        deviceName: 'Command Center browser',
        deviceKind: 'command-center',
      });
      this.pairingCode = undefined;
      this.explicitSignIn = false;
      this.person.startRefresh((error) => this.failPersonRefresh(error));
      return;
    }
    if (this.personStorage.required && !this.explicitSignIn) throw new PersonSessionEndedError();
    let result: GatewayAuthConnectResult;
    try {
      result = await this.rawRequest<GatewayAuthConnectResult>(Methods.AUTH_CONNECT, {
        clientKind: 'ui',
        ...this.auth,
      });
    } catch (error) {
      if (!hasAuthErrorCode(error, 'AUTH_PERSON_SESSION_REQUIRED')) throw error;
      if (!this.explicitSignIn) {
        await saveDesktopCredentials({});
        replaceStoredGatewayAuthForHttp({});
        throw new GatewayRequestError(
          'Sign in again to create a device session.',
          'AUTH_PERSON_SESSION_REQUIRED',
        );
      }
      if (!this.auth.token || this.auth.password)
        throw new GatewayRequestError(
          'Use a person credential or pairing code to sign in.',
          'AUTH_PERSON_SESSION_REQUIRED',
        );
      await this.person.exchange({
        credential: this.auth.token,
        deviceName: isDesktopClient() ? 'Command Center desktop' : 'Command Center browser',
        deviceKind: 'command-center',
      });
      this.explicitSignIn = false;
      this.person.startRefresh((error) => this.failPersonRefresh(error));
      return;
    }
    if (!result.ok) throw new GatewayRequestError('Gateway authentication failed', 'AUTH_FAILED');
    if (this.ws !== socket || this.disposed) return;
    if (result.principal?.subjectKind === 'person')
      throw new GatewayRequestError(
        'Sign in with a person credential or pairing code, not an access token.',
        'AUTH_PERSON_SESSION_REQUIRED',
      );
    if (this.auth.token || this.auth.password) {
      if (result.principal?.subjectKind !== 'service' && result.principal?.subjectKind !== 'node')
        throw new GatewayRequestError(
          'Update the gateway to verify this credential before saving it.',
          'AUTH_FAILED',
        );
      await saveDesktopCredentials(this.auth, this.rememberMe);
      replaceStoredGatewayAuthForHttp(this.auth);
      setGatewayMemoryAuth(this.auth, this.url);
      syncBrowserHttpAuthCookie(this.auth, this.url);
    }
    if (this.ws !== socket || this.disposed) return;
    this.explicitSignIn = false;
    this.acceptAuthentication(result);
  }

  private failPersonRefresh(error: unknown): void {
    this.lastAuthError = new GatewayRequestError(
      error instanceof Error ? error.message : 'Device sign-in refresh failed.',
      hasAuthErrorCode(error, 'AUTH_SESSION_ENDED') ? 'AUTH_SESSION_ENDED' : 'AUTH_REFRESH_FAILED',
    );
    clearGatewayMemoryAuth();
    if (hasAuthErrorCode(error, 'AUTH_SESSION_ENDED')) this.authBlocked = true;
    this.rejectAllPending(this.lastAuthError.message);
    this.teardownSocket();
    this.setState(this.authBlocked ? 'auth_required' : 'disconnected');
    if (!this.authBlocked) this.scheduleReconnect();
  }

  private acceptAuthentication(result: GatewayAuthConnectResult): void {
    this.principal = result.principal ?? null;
    this.adminRole =
      result.principal?.roles.some(
        ({ role, scope }) => role === 'admin' && scope.kind === 'global',
      ) ?? false;
    this.access = workspaceAccessFromAuth(result);
    this.epoch += 1;
    this.backoff = 1000;
    this.lastAuthError = null;
    this.authBlocked = false;
    this.setState('connected');
  }

  reconnect(): void {
    if (this.disposed || this.authBlocked) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.backoff = 1000;
    this.rejectAllPending('Gateway reconnecting');
    this.teardownSocket();
    this.setState('disconnected');
    this.connect();
  }

  disconnect(): void {
    this.disposed = true;
    void this.person.dispose();
    clearGatewayMemoryAuth();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.rejectAllPending('Client disconnected');
    this.teardownSocket();
    this.setState('disconnected');
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutOrOptions: number | GatewayRequestOptions = DEFAULT_TIMEOUT,
  ): Promise<T> {
    if (this.person.session && !method.startsWith('auth.'))
      return this.person.withAccess(() => this.rawRequest<T>(method, params, timeoutOrOptions));
    return this.rawRequest<T>(method, params, timeoutOrOptions);
  }

  private async rawRequest<T = unknown>(
    method: string,
    params?: unknown,
    timeoutOrOptions: number | GatewayRequestOptions = DEFAULT_TIMEOUT,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }

    const options = normalizeGatewayRequestOptions(timeoutOrOptions, DEFAULT_TIMEOUT);
    const timeout = options.timeout;
    const id = String(++this.reqId);
    const frame: RequestFrame = { type: 'req', id, method, params };
    const t0 = performance.now();

    const result = await new Promise<T>((resolve, reject) => {
      let settled = false;
      let unsub: (() => void) | undefined;
      let idle: ReturnType<typeof createIdleRequestTimeout>;
      const finish = (next: () => void) => {
        if (settled) return;
        settled = true;
        idle.clear();
        unsub?.();
        this.pending.delete(id);
        next();
      };
      idle = createIdleRequestTimeout({
        timeoutMs: timeout,
        onTimeout: () => {
          finish(() => {
            const suffix = options.extendOnEvent
              ? ` without a matching ${options.extendOnEvent} event`
              : '';
            reject(
              new GatewayRequestTimeoutError(
                `Request ${method} timed out after ${timeout}ms${suffix}`,
              ),
            );
          });
        },
      });

      this.pending.set(id, {
        resolve: (v: unknown) => {
          finish(() => {
            const dt = performance.now() - t0;
            // Surface slow calls so the source of perceived UI latency is obvious.
            if (dt > 100) console.log(`[gateway] ${method} ${dt.toFixed(0)}ms`);
            resolve(v as T);
          });
        },
        reject: (err: Error) => finish(() => reject(err)),
      });

      if (options.extendOnEvent) {
        unsub = this.subscribe(options.extendOnEvent, (payload) => {
          if (settled) return;
          if (options.extendWhen && !options.extendWhen(payload)) return;
          idle.extend();
        });
      }

      this.ws!.send(JSON.stringify(frame));
    });
    return result;
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

  private advanceGatewayCandidate(): void {
    if (this.urls.length <= 1) return;
    this.urlIndex = (this.urlIndex + 1) % this.urls.length;
    this.url = this.urls[this.urlIndex];
    this.persistConnection();
  }

  private persistConnection(): void {
    if (isDesktopClient() || this.source === 'implicit') {
      return;
    }
    localStorage.setItem(GATEWAY_URL_STORAGE_KEY, this.url);
    localStorage.setItem(GATEWAY_CANDIDATES_STORAGE_KEY, JSON.stringify(this.urls));
    localStorage.setItem(GATEWAY_SOURCE_STORAGE_KEY, 'stored');
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
    const pending = [...this.pending.values()];
    for (const req of pending) {
      req.reject(new Error(reason));
    }
  }
}

// Singleton instance
export const gateway = new GatewayClient();
