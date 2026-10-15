import { isRecord } from './recipe/common.js';
import {
  parsePersonDeviceSession,
  parsePersonSessionAuth,
  parsePersonSessionGrant,
  type PersonDeviceSession,
  type PersonSessionAuth,
  type PersonSessionExchangeParams,
  type PersonSessionGrant,
} from './rpc/auth.js';
import { Methods } from './rpc/registry.js';

export interface PersonSessionStorage {
  load(): Promise<unknown>;
  save(value: PersonSessionAuth | null): Promise<void>;
}

/** Interactive transports keep these fields out of auth.connect serialization. */
export interface InteractiveGatewayCredentials {
  token?: string;
  password?: string;
  sessionStorage?: PersonSessionStorage;
  explicitPersonSignIn?: boolean;
  personSessionRequired?: boolean;
}

export interface PersonSessionClientOptions {
  storage: PersonSessionStorage;
  /** The optional access token authenticates this request, never the refresh token. */
  request(method: string, params: unknown, accessToken?: string): Promise<unknown>;
  now?: () => number;
  /** Connected clients re-authenticate their socket and update HTTP credentials here. */
  onAccess?: (grant: PersonSessionGrant) => Promise<void>;
}

export class PersonSessionEndedError extends Error {
  readonly code = 'AUTH_SESSION_ENDED';
  constructor() {
    super('Your device sign-in has ended. Sign in again.');
    this.name = 'PersonSessionEndedError';
  }
}

export class PersonSessionChangedError extends Error {
  constructor() {
    super('The selected sign-in changed while the request was in flight.');
    this.name = 'PersonSessionChangedError';
  }
}

export function hasAuthErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** One instance belongs to one explicitly selected gateway profile. */
export class PersonSessionClient {
  private saved: PersonSessionAuth | null = null;
  private grant: PersonSessionGrant | null = null;
  private accessDeadline = 0;
  private loadTask: Promise<void> | null = null;
  private refreshTask: Promise<string> | null = null;
  private exchangeTask: Promise<string> | null = null;
  private writeTask: Promise<void> | null = null;
  private generation = 0;
  private disposed = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshFailure: ((error: unknown) => void) | undefined;
  private readonly now: () => number;

  constructor(private readonly options: PersonSessionClientOptions) {
    this.now = options.now ?? Date.now;
  }

  get session(): PersonDeviceSession | null {
    return this.disposed ? null : (this.saved?.session ?? null);
  }

  get currentAccessToken(): string | null {
    return !this.disposed && this.grant && this.now() < this.accessDeadline
      ? this.grant.accessToken
      : null;
  }

  async restore(): Promise<void> {
    if (!this.loadTask) {
      const generation = this.generation;
      this.loadTask = (async () => {
        const saved = await this.options.storage.load();
        this.assertCurrent(generation);
        const parsed = saved === null ? null : parsePersonSessionAuth(saved);
        if (saved !== null && !parsed)
          throw new Error('The saved device sign-in is invalid. Sign in again.');
        this.saved = parsed;
      })();
    }
    const task = this.loadTask;
    try {
      await task;
    } catch (error) {
      if (this.loadTask === task) this.loadTask = null;
      throw error;
    }
  }

  async exchange(params: PersonSessionExchangeParams): Promise<string> {
    const generation = ++this.generation;
    this.clearTimer();
    this.refreshTask = null;
    const task = (async () => {
      const grant = await this.options.request(Methods.AUTH_SESSION_EXCHANGE, params);
      const accepted = await this.adopt(grant, generation);
      this.loadTask = Promise.resolve();
      return accepted.accessToken;
    })();
    this.exchangeTask = task;
    try {
      return await task;
    } finally {
      if (this.exchangeTask === task) this.exchangeTask = null;
    }
  }

  async accessToken(forceRefresh = false): Promise<string> {
    if (this.exchangeTask) return this.exchangeTask;
    await this.restore();
    if (this.exchangeTask) return this.exchangeTask;
    this.assertCurrent(this.generation);
    if (!forceRefresh && this.grant && this.now() < this.accessDeadline - 30_000)
      return this.grant.accessToken;
    if (this.refreshTask) return this.refreshTask;
    if (!this.saved) throw new PersonSessionEndedError();
    const generation = this.generation;
    const expected = this.saved;
    const refreshToken = expected.refreshToken;
    const task = (async () => {
      let grant: unknown;
      try {
        grant = await this.options.request(Methods.AUTH_SESSION_REFRESH, { refreshToken });
      } catch (error) {
        this.assertCurrent(generation);
        if (!hasAuthErrorCode(error, 'AUTH_SESSION_ENDED')) throw error;
        await this.clear(generation);
        throw new PersonSessionEndedError();
      }
      const accepted = await this.adopt(grant, generation, expected);
      return accepted.accessToken;
    })();
    this.refreshTask = task;
    try {
      return await task;
    } finally {
      if (this.refreshTask === task) this.refreshTask = null;
    }
  }

  async list(): Promise<PersonDeviceSession[]> {
    const result = await this.requestWithAccess(Methods.AUTH_SESSION_LIST, {});
    if (!isRecord(result) || !Array.isArray(result.sessions))
      throw new Error('Invalid signed-in device list.');
    return result.sessions.map((value: unknown) => {
      const session = parsePersonDeviceSession(value);
      if (!session) throw new Error('Invalid signed-in device metadata.');
      return session;
    });
  }

  async revoke(sessionId: string): Promise<void> {
    const generation = this.generation;
    const result = await this.requestWithAccess(Methods.AUTH_SESSION_REVOKE, { sessionId });
    this.assertCurrent(generation);
    const session = isRecord(result) ? parsePersonDeviceSession(result.session) : null;
    if (!session || session.id !== sessionId || session.revokedAt === null)
      throw new Error('The gateway did not confirm device sign-out. Try again.');
    if (this.saved?.session.id === sessionId) await this.clear(generation);
  }

  /** The caller confirms first. A transport failure preserves the saved login for retry. */
  async signOut(): Promise<void> {
    await this.restore();
    this.clearTimer();
    if (!this.saved) return;
    try {
      await this.revoke(this.saved.session.id);
    } catch (error) {
      if (!(error instanceof PersonSessionEndedError)) throw error;
      // A rejected refresh already cleared this confirmed expired/revoked session.
    }
  }

  /** Command Center and Companion keep idle sockets authenticated; CLI does not start a loop. */
  startRefresh(onFailure: (error: unknown) => void): void {
    this.refreshFailure = onFailure;
    this.scheduleRefresh();
  }

  stopRefresh(): void {
    this.refreshFailure = undefined;
    this.clearTimer();
  }

  /** Await before replacing this profile's storage adapter. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.generation += 1;
    this.stopRefresh();
    await this.writeTask;
  }

  async withAccess<T>(operation: (accessToken: string) => Promise<T>): Promise<T> {
    const generation = this.generation;
    const accessToken = await this.accessToken();
    this.assertCurrent(generation);
    let result: T;
    try {
      result = await operation(accessToken);
    } catch (error) {
      this.assertCurrent(generation);
      if (!hasAuthErrorCode(error, 'AUTH_SESSION_ENDED')) throw error;
      const renewed = await this.accessToken(true);
      this.assertCurrent(generation);
      result = await operation(renewed);
    }
    this.assertCurrent(generation);
    return result;
  }

  private requestWithAccess(method: string, params: unknown): Promise<unknown> {
    return this.withAccess((accessToken) => this.options.request(method, params, accessToken));
  }

  private async adopt(
    value: unknown,
    generation: number,
    expected?: PersonSessionAuth,
  ): Promise<PersonSessionGrant> {
    this.assertCurrent(generation);
    const grant = parsePersonSessionGrant(value);
    const lifetime = grant
      ? Date.parse(grant.accessExpiresAt) - Date.parse(grant.session.lastRefreshedAt)
      : 0;
    if (!grant || lifetime <= 0 || lifetime > 3600_000)
      throw new Error('The gateway returned an invalid or expired device sign-in. Try again.');
    if (
      expected &&
      (grant.session.id !== expected.session.id ||
        grant.session.principalId !== expected.session.principalId ||
        grant.session.principalGeneration !== expected.session.principalGeneration ||
        grant.refreshToken !== expected.refreshToken)
    )
      throw new Error('The gateway refresh changed the selected device sign-in. Sign in again.');
    const saved = { session: grant.session, refreshToken: grant.refreshToken };
    await this.persist(saved, generation);
    this.assertCurrent(generation);
    this.saved = saved;
    this.grant = grant;
    // The gateway owns UTC expiry. Plan renewal from its issued lifetime, not a device's clock offset.
    this.accessDeadline = this.now() + lifetime;
    await this.options.onAccess?.(grant);
    this.assertCurrent(generation);
    this.scheduleRefresh();
    return grant;
  }

  private async clear(generation: number): Promise<void> {
    await this.persist(null, generation);
    this.assertCurrent(generation);
    this.generation += 1;
    this.saved = null;
    this.grant = null;
    this.accessDeadline = 0;
    this.loadTask = Promise.resolve();
    this.clearTimer();
  }

  private async persist(value: PersonSessionAuth | null, generation: number): Promise<void> {
    if (this.writeTask) await this.writeTask;
    this.assertCurrent(generation);
    const task = this.options.storage.save(value);
    this.writeTask = task;
    try {
      await task;
    } finally {
      if (this.writeTask === task) this.writeTask = null;
    }
  }

  private assertCurrent(generation: number): void {
    if (this.disposed || generation !== this.generation) throw new PersonSessionChangedError();
  }

  private clearTimer(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private scheduleRefresh(): void {
    this.clearTimer();
    if (!this.refreshFailure || !this.grant || this.disposed) return;
    const generation = this.generation;
    const onFailure = this.refreshFailure;
    this.refreshTimer = setTimeout(
      () => {
        this.refreshTimer = undefined;
        this.accessToken(true).catch((error: unknown) => {
          // A superseded loop must not report into another sign-in or a disposed client.
          if (this.disposed || generation !== this.generation) return;
          onFailure(error);
        });
      },
      Math.max(0, this.accessDeadline - this.now() - 30_000),
    );
  }
}
