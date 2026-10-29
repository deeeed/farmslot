import type { ConfigGitHubAccountsResult, UpstreamObservation } from '@farmslot/protocol';

export const GITHUB_ACCOUNTS_TTL_MS = 5 * 60_000;
export const GITHUB_ACCOUNTS_LEGACY_INTEREST_MS = 6 * 60_000;
const MAX_LEGACY_INTERESTS = 128;

export interface GitHubAccountsReadInterest {
  legacyClientId?: string;
  legacyInterest?: boolean;
}

interface GitHubAccountObservationOptions {
  sample(): Promise<ConfigGitHubAccountsResult>;
  hasInterest(): boolean;
  changed(): void;
  now?: () => number;
}

/** The source clock belongs to a verified inventory, not to a client's cached read. */
export class GitHubAccountObservation {
  private accounts: ConfigGitHubAccountsResult['accounts'] = [];
  private observedAt?: number;
  private attemptedAt?: number;
  private error?: string;
  private pending?: Promise<void>;
  private queuedRefresh?: Promise<void>;
  private stopped = false;
  private published?: string;
  private readonly anonymousLegacyClient = Symbol('legacy-github-account-reader');
  private readonly legacyInterest = new Map<string | symbol, number>();
  private readonly now: () => number;

  constructor(private readonly options: GitHubAccountObservationOptions) {
    this.now = options.now ?? Date.now;
  }

  get observation(): UpstreamObservation {
    return {
      status: this.error
        ? this.observedAt === undefined
          ? 'error'
          : 'stale'
        : this.observedAt === undefined || this.now() - this.observedAt >= GITHUB_ACCOUNTS_TTL_MS
          ? 'stale'
          : 'ready',
      ...(this.observedAt === undefined ? {} : { observedAt: this.observedAt }),
      ...(this.error
        ? { error: { code: 'GITHUB_ACCOUNTS_UNAVAILABLE', message: this.error } }
        : {}),
    };
  }

  snapshot(): ConfigGitHubAccountsResult {
    const checkedAt = this.observedAt ?? this.attemptedAt;
    return {
      accounts: this.accounts.map(({ host, login, active }) => ({ host, login, active })),
      checkedAt: checkedAt === undefined ? '' : new Date(checkedAt).toISOString(),
      ...(this.error ? { error: this.error } : {}),
      observation: this.observation,
    };
  }

  async read(
    force = false,
    interest: GitHubAccountsReadInterest = {},
  ): Promise<ConfigGitHubAccountsResult> {
    if (this.stopped) return this.snapshot();
    this.hasLegacyInterest();
    if (interest.legacyInterest !== false) {
      const client = interest.legacyClientId ?? this.anonymousLegacyClient;
      this.legacyInterest.delete(client);
      this.legacyInterest.set(client, this.now());
      if (this.legacyInterest.size > MAX_LEGACY_INTERESTS)
        this.legacyInterest.delete(this.legacyInterest.keys().next().value!);
    } else if (interest.legacyClientId !== undefined) this.forget(interest.legacyClientId);
    if (
      this.pending ||
      force ||
      this.attemptedAt === undefined ||
      (interest.legacyInterest !== false && this.due())
    )
      await this.refresh(force);
    return this.snapshot();
  }

  forget(clientId: string): void {
    this.legacyInterest.delete(clientId);
  }

  start(): void {
    this.stopped = false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.legacyInterest.clear();
    await Promise.all([this.pending, this.queuedRefresh]);
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    this.publish();
    if ((this.options.hasInterest() || this.hasLegacyInterest()) && this.due())
      await this.refresh(false);
  }

  private due(): boolean {
    return (
      this.attemptedAt === undefined || this.now() - this.attemptedAt >= GITHUB_ACCOUNTS_TTL_MS
    );
  }

  private hasLegacyInterest(): boolean {
    for (const [client, at] of this.legacyInterest)
      if (this.now() - at >= GITHUB_ACCOUNTS_LEGACY_INTEREST_MS) this.legacyInterest.delete(client);
    return this.legacyInterest.size > 0;
  }

  private refresh(force: boolean): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) {
      if (!force) return this.pending;
      this.queuedRefresh ??= this.pending
        .then(() => (this.stopped ? undefined : this.refresh(false)))
        .finally(() => {
          this.queuedRefresh = undefined;
        });
      return this.queuedRefresh;
    }
    this.pending = (async () => {
      const result = await this.options.sample();
      this.attemptedAt = this.now();
      this.error = result.error;
      if (!result.error) {
        this.accounts = result.accounts.map(({ host, login, active }) => ({ host, login, active }));
        this.observedAt = this.attemptedAt;
      }
      this.publish();
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private publish(): void {
    if (this.stopped || this.attemptedAt === undefined) return;
    const signature = JSON.stringify(this.snapshot());
    if (signature === this.published) return;
    this.published = signature;
    this.options.changed();
  }
}
