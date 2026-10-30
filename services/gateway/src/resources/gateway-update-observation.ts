import type { GatewayUpdateStatus, UpstreamObservation } from '@farmslot/protocol';

export const GATEWAY_UPDATE_SUCCESS_TTL_MS = 15 * 60_000;
export const GATEWAY_UPDATE_ERROR_TTL_MS = 60_000;
export const GATEWAY_UPDATE_LEGACY_INTEREST_MS = 6 * 60_000;

export interface GatewayUpdateClientInterest {
  legacyClientId?: string;
  legacyInterest?: boolean;
}

interface GatewayUpdateObservationOptions {
  sample(): Promise<GatewayUpdateStatus>;
  hasInterest(): boolean;
  changed(): void;
  empty(): GatewayUpdateStatus;
  now?: () => number;
}

/** One remote observation, independent of how many clients read its retained value. */
export class GatewayUpdateObservation {
  private value?: GatewayUpdateStatus;
  private observedAt?: number;
  private attemptedAt?: number;
  private inFlight?: Promise<void>;
  private published?: string;
  private stopped = false;
  private readonly anonymousLegacyClient = Symbol('legacy-gateway-status-reader');
  private readonly legacyInterest = new Map<string | symbol, number>();
  private readonly now: () => number;

  constructor(private readonly options: GatewayUpdateObservationOptions) {
    this.now = options.now ?? Date.now;
  }

  get observation(): UpstreamObservation {
    const error = this.value?.error;
    return {
      status: error
        ? this.observedAt === undefined
          ? 'error'
          : 'stale'
        : this.observedAt === undefined ||
            this.now() - this.observedAt >= GATEWAY_UPDATE_SUCCESS_TTL_MS
          ? 'stale'
          : 'ready',
      ...(this.observedAt === undefined ? {} : { observedAt: this.observedAt }),
      ...(error ? { error: { code: 'GATEWAY_UPDATE_SOURCE_UNAVAILABLE', message: error } } : {}),
    };
  }

  snapshot(): GatewayUpdateStatus {
    return structuredClone(this.value ?? this.options.empty());
  }

  async read(
    force = false,
    interest: GatewayUpdateClientInterest = { legacyInterest: false },
  ): Promise<GatewayUpdateStatus> {
    if (this.stopped) return this.snapshot();
    const legacy = interest.legacyInterest !== false;
    this.hasLegacyInterest();
    if (legacy)
      this.legacyInterest.set(interest.legacyClientId ?? this.anonymousLegacyClient, this.now());
    else if (interest.legacyClientId !== undefined)
      this.forgetLegacyClientInterest(interest.legacyClientId);
    // A cold authorized read captures the source once. Warm reads never renew its source age.
    // Legacy viewers retain their former TTL check until they adopt explicit observer admission.
    if (force || this.attemptedAt === undefined || (legacy && this.due())) await this.refresh();
    return this.snapshot();
  }

  forgetLegacyClientInterest(clientId: string): void {
    this.legacyInterest.delete(clientId);
  }

  private hasLegacyInterest(): boolean {
    const now = this.now();
    for (const [clientId, lastRead] of this.legacyInterest)
      if (now - lastRead >= GATEWAY_UPDATE_LEGACY_INTEREST_MS) this.legacyInterest.delete(clientId);
    return this.legacyInterest.size > 0;
  }

  private due(): boolean {
    const ttl = this.value?.error ? GATEWAY_UPDATE_ERROR_TTL_MS : GATEWAY_UPDATE_SUCCESS_TTL_MS;
    return this.attemptedAt === undefined || this.now() - this.attemptedAt >= ttl;
  }

  start(): void {
    this.stopped = false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.legacyInterest.clear();
    await this.inFlight;
  }

  /** Called by the owning service's slow scheduler or a newly admitted visible observer. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const legacy = this.hasLegacyInterest();
    // A due check publishes its result once. Publishing the expired age first would flip viewers
    // to stale for the length of the check and back.
    if ((this.options.hasInterest() || legacy) && this.due()) return this.refresh();
    this.publish();
  }

  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      let next: GatewayUpdateStatus;
      try {
        next = await this.options.sample();
      } catch (error) {
        next = {
          ...this.options.empty(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
      this.attemptedAt = this.now();
      if (!next.error) {
        this.value = next;
        this.observedAt = this.attemptedAt;
      } else {
        // Failure does not erase the last successful source facts or bless them with a new age.
        this.value = { ...(this.value ?? next), error: next.error };
      }
      this.publish();
    })().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Installed refs change independently of remote sampling; preserve source success time. */
  installedChanged(update: Partial<GatewayUpdateStatus>): void {
    if (this.stopped) return;
    this.value = { ...(this.value ?? this.options.empty()), ...update };
    this.publish();
  }

  private publish(): void {
    if (this.stopped || this.value === undefined) return;
    const signature = JSON.stringify({ value: this.value, observation: this.observation });
    if (signature === this.published) return;
    this.published = signature;
    this.options.changed();
  }
}
