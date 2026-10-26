// Gateway-owned PR detail observations. One bounded collector per normalized upstream query,
// shared by every viewer; passive collection runs only while a managed or legacy reader is interested.
import type { UpstreamObservation } from '@farmslot/protocol';
import { canonicalResourceJson, type ResourceKey } from '@farmslot/protocol/client-cache';

import { GatewayMethodError } from '../../core/method-error.js';
import {
  githubQueryBudget,
  GitHubQueryBudgetError,
} from '../../integrations/github-query-budget.js';
import { resourceRevisions } from '../../resources/revisions.js';

export const PR_DETAIL_STALE_MS = 60_000;
export const PR_DETAIL_CLIENT_INTEREST_MS = 6 * 60_000;
const BACKOFF_MS = [PR_DETAIL_STALE_MS, 2 * 60_000, 5 * 60_000] as const;
/** Older than the slowest healthy cadence: no passive collection is keeping the value current. */
export const PR_DETAIL_READY_MS = BACKOFF_MS[BACKOFF_MS.length - 1] + PR_DETAIL_STALE_MS;
const MAX_QUERIES = 128;
const MAX_LEGACY_CLIENTS = 128;
const anonymousLegacyClient = Symbol('legacy-pr-detail-reader');

export interface PRDetailReadInterest {
  legacyInterest?: boolean;
  legacyClientId?: string;
}

export interface UpstreamSample<V> {
  value: V;
  /** Completion time of the upstream read that produced the value; defaults to now. */
  observedAt?: number;
}

export interface PRDetailCollectorOptions<P, V> {
  method: string;
  normalize(params: unknown): P;
  fetch(params: P, force: boolean): Promise<UpstreamSample<V>>;
  /** Another owner's retained observation of the same source. It never performs I/O upstream. */
  seed?(params: P): Promise<UpstreamSample<V> | undefined>;
  now?: () => number;
}

type Outcome = { ok: true } | { ok: false; error: unknown };

interface Inflight {
  forced: boolean;
  promise: Promise<Outcome>;
}

interface Entry<P, V> {
  id: string;
  params: P;
  value?: V;
  valueSignature?: string;
  observedAt?: number;
  attemptedAt?: number;
  failure?: { code: string; message: string; cause: unknown; at: number };
  inflight?: Inflight;
  queuedForced?: Promise<Outcome>;
  legacyInterest: Map<string | symbol, number>;
  streak: number;
  lastUsed: number;
  published?: string;
}

function failureCode(error: unknown): string {
  if (error instanceof GatewayMethodError) return error.code;
  if (error instanceof GitHubQueryBudgetError) return 'UPSTREAM_RATE_LIMITED';
  return 'UPSTREAM_UNAVAILABLE';
}

function failureMessage(error: unknown): string {
  // Raw gh errors can carry stderr and local paths; only messages the gateway wrote are exposed.
  if (error instanceof GatewayMethodError || error instanceof GitHubQueryBudgetError)
    return error.message.slice(0, 200);
  return 'GitHub could not be read.';
}

export class PRDetailCollector<P, V> {
  private readonly entries = new Map<string, Entry<P, V>>();
  private readonly now: () => number;
  private hasObservers: (params: P) => boolean = () => false;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private useSerial = 0;
  private lastReserveLogAt = 0;

  constructor(private readonly options: PRDetailCollectorOptions<P, V>) {
    this.now = options.now ?? Date.now;
  }

  normalize(params: unknown): P {
    try {
      return this.options.normalize(params);
    } catch (error) {
      throw new GatewayMethodError(
        'INVALID_PARAMS',
        error instanceof Error ? error.message : 'Invalid upstream observation',
      );
    }
  }

  queryId(params: P): string {
    return `${this.options.method}:${canonicalResourceJson(params)}`;
  }

  resourceKey(params: P): Extract<ResourceKey, { family: 'upstream' }> {
    return { family: 'upstream', integration: 'github', queryId: this.queryId(params) };
  }

  /**
   * Passive reads share the retained value. Legacy readers keep their freshness on read; managed
   * readers never renew interest or start collection once warm. `force` is an explicit check that
   * joins forced work in flight and fails visibly. `accept` rejects a value for a superseded context.
   */
  async read(
    params: unknown,
    opts: PRDetailReadInterest & { force?: boolean; accept?(value: V): boolean } = {},
  ): Promise<{ value: V; observation: UpstreamObservation }> {
    const entry = this.entryFor(this.normalize(params));
    const now = this.now();
    if (opts.legacyInterest !== false) {
      const client = opts.legacyClientId ?? anonymousLegacyClient;
      entry.legacyInterest.delete(client);
      entry.legacyInterest.set(client, now);
      if (entry.legacyInterest.size > MAX_LEGACY_CLIENTS)
        entry.legacyInterest.delete(entry.legacyInterest.keys().next().value!);
    } else if (opts.legacyClientId !== undefined) entry.legacyInterest.delete(opts.legacyClientId);
    if (entry.value === undefined && !entry.inflight && this.options.seed) {
      const seeded = await this.options.seed(entry.params);
      if (seeded && this.adopt(entry, seeded)) this.publish(entry);
    }
    const accepted = () =>
      entry.value !== undefined && (opts.accept ? opts.accept(entry.value) : true);
    if (opts.force) {
      const outcome = await this.refresh(entry, true);
      if (!outcome.ok) throw outcome.error;
    } else if (entry.value === undefined) {
      if (entry.inflight || entry.queuedForced || !entry.failure || this.eligible(entry, now))
        await this.refresh(entry, false);
    } else if (!accepted()) {
      await this.refresh(entry, false);
    } else if (entry.queuedForced || entry.inflight?.forced) {
      // An explicit check or completed command is re-collecting; never answer from before it.
      await (entry.queuedForced ?? entry.inflight!.promise);
    } else if (
      opts.legacyInterest !== false &&
      this.eligible(entry, now) &&
      !this.fresh(entry, now) &&
      !this.budgetReserved(now)
    ) {
      await this.refresh(entry, false);
    }
    if (!accepted())
      throw (
        entry.failure?.cause ??
        new GatewayMethodError(
          entry.value === undefined ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_OBSOLETE',
          'No current upstream observation is available',
        )
      );
    return { value: entry.value!, observation: this.observation(entry) };
  }

  /** Adopt newer values another owner already observed from the same source. */
  observe(select: (params: P, value: V | undefined) => UpstreamSample<V> | undefined): void {
    for (const entry of this.entries.values()) {
      const sample = select(entry.params, entry.value);
      if (sample && this.adopt(entry, sample)) this.publish(entry);
    }
  }

  /** An explicit command completed: matching observations re-collect now, bypassing caches. */
  refreshWhere(match: (params: P, value: V | undefined) => boolean): P[] {
    const matched = [...this.entries.values()].filter((entry) => match(entry.params, entry.value));
    for (const entry of matched) void this.refresh(entry, true);
    return matched.map((entry) => entry.params);
  }

  forget(clientId: string): void {
    for (const entry of this.entries.values()) entry.legacyInterest.delete(clientId);
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    if (this.budgetReserved(now)) return;
    const pending: Promise<Outcome>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.inflight || entry.queuedForced || !this.due(entry, now)) continue;
      if (!this.hasLegacyInterest(entry, now) && !this.hasObservers(entry.params)) continue;
      pending.push(this.refresh(entry, false));
    }
    await Promise.all(pending);
  }

  start(options: { hasInterest(params: P): boolean }): () => Promise<void> {
    if (this.timer) throw new Error(`${this.options.method} observation is already running`);
    this.stopped = false;
    this.hasObservers = options.hasInterest;
    const timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        console.warn(
          `[${this.options.method}] passive collection failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
      });
    }, PR_DETAIL_STALE_MS);
    timer.unref();
    this.timer = timer;
    return async () => {
      if (this.timer !== timer) return;
      clearInterval(timer);
      this.timer = undefined;
      this.stopped = true;
      this.hasObservers = () => false;
      for (const entry of this.entries.values()) entry.legacyInterest.clear();
      // Drain collection already in flight; its completion no longer publishes.
      await Promise.all(
        [...this.entries.values()].flatMap((entry) => [
          entry.inflight?.promise,
          entry.queuedForced,
        ]),
      );
    };
  }

  resetForTests(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.entries.clear();
    this.stopped = false;
    this.hasObservers = () => false;
    this.useSerial = 0;
    this.lastReserveLogAt = 0;
  }

  private entryFor(params: P): Entry<P, V> {
    const id = this.queryId(params);
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= MAX_QUERIES) {
        const now = this.now();
        const oldest = [...this.entries.values()]
          .filter(
            (candidate) =>
              !candidate.inflight &&
              !candidate.queuedForced &&
              !this.hasLegacyInterest(candidate, now) &&
              !this.hasObservers(candidate.params),
          )
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!oldest)
          throw new GatewayMethodError('RESOURCE_LIMIT', 'Too many active upstream PR queries');
        this.entries.delete(oldest.id);
      }
      entry = { id, params, legacyInterest: new Map(), streak: 0, lastUsed: 0 };
      this.entries.set(id, entry);
    }
    entry.lastUsed = ++this.useSerial;
    return entry;
  }

  private hasLegacyInterest(entry: Entry<P, V>, now: number): boolean {
    for (const [client, at] of entry.legacyInterest)
      if (now - at >= PR_DETAIL_CLIENT_INTEREST_MS) entry.legacyInterest.delete(client);
    return entry.legacyInterest.size > 0;
  }

  private eligible(entry: Entry<P, V>, now: number): boolean {
    return entry.attemptedAt === undefined || now - entry.attemptedAt >= PR_DETAIL_STALE_MS;
  }

  private fresh(entry: Entry<P, V>, now: number): boolean {
    return entry.observedAt !== undefined && now - entry.observedAt < PR_DETAIL_STALE_MS;
  }

  /** Passive cadence: at least one minute apart, slower while results stay unchanged or failing. */
  private due(entry: Entry<P, V>, now: number): boolean {
    if (this.fresh(entry, now)) return false;
    return (
      entry.attemptedAt === undefined ||
      now - entry.attemptedAt >= BACKOFF_MS[Math.min(entry.streak, BACKOFF_MS.length - 1)]
    );
  }

  private budgetReserved(now: number): boolean {
    const retryAt = githubQueryBudget.anyReserved(now);
    if (!retryAt) return false;
    if (now - this.lastReserveLogAt > PR_DETAIL_STALE_MS) {
      this.lastReserveLogAt = now;
      console.warn(
        `[${this.options.method}] GraphQL budget reserved until ${retryAt}; keeping retained values`,
      );
    }
    return true;
  }

  private observation(entry: Entry<P, V>): UpstreamObservation {
    const stale =
      entry.failure !== undefined ||
      entry.observedAt === undefined ||
      this.now() - entry.observedAt >= PR_DETAIL_READY_MS;
    return {
      status: entry.value === undefined ? 'error' : stale ? 'stale' : 'ready',
      ...(entry.observedAt === undefined ? {} : { observedAt: entry.observedAt }),
      ...(entry.failure
        ? { error: { code: entry.failure.code, message: entry.failure.message } }
        : {}),
    };
  }

  private adopt(entry: Entry<P, V>, sample: UpstreamSample<V>): boolean {
    const observedAt = sample.observedAt ?? this.now();
    if (entry.observedAt !== undefined && observedAt <= entry.observedAt) return false;
    // A newer absence is not overturned by an older retained value.
    if (entry.failure?.code === 'NOT_FOUND' && entry.failure.at >= observedAt) return false;
    entry.value = sample.value;
    entry.valueSignature = JSON.stringify(sample.value);
    entry.observedAt = observedAt;
    if (entry.failure && entry.failure.at <= observedAt) entry.failure = undefined;
    return true;
  }

  private refresh(entry: Entry<P, V>, force: boolean): Promise<Outcome> {
    if (!entry.inflight) return this.runRefresh(entry, force);
    if (!force || entry.inflight.forced) return entry.inflight.promise;
    entry.queuedForced ??= entry.inflight.promise
      .then(() => this.runRefresh(entry, true))
      .finally(() => {
        entry.queuedForced = undefined;
      });
    return entry.queuedForced;
  }

  private runRefresh(entry: Entry<P, V>, force: boolean): Promise<Outcome> {
    if (this.stopped)
      return Promise.resolve({
        ok: false,
        error: new GatewayMethodError('UPSTREAM_OBSOLETE', 'Upstream PR observation is stopped'),
      });
    entry.attemptedAt = this.now();
    const inflight: Inflight = {
      forced: force,
      promise: Promise.resolve().then(() => this.collect(entry, force, inflight)),
    };
    entry.inflight = inflight;
    return inflight.promise;
  }

  private async collect(entry: Entry<P, V>, force: boolean, inflight: Inflight): Promise<Outcome> {
    const before = entry.valueSignature;
    try {
      const sample = await this.options.fetch(entry.params, force);
      if (this.entries.get(entry.id) !== entry)
        return {
          ok: false,
          error: new GatewayMethodError('UPSTREAM_OBSOLETE', 'PR collector was retired'),
        };
      // Success time is when this upstream read completed, never when it started.
      const observedAt = sample.observedAt ?? this.now();
      if (entry.observedAt === undefined || observedAt >= entry.observedAt) {
        entry.value = sample.value;
        entry.valueSignature = JSON.stringify(sample.value);
        entry.observedAt = observedAt;
      }
      entry.failure = undefined;
      entry.streak = entry.valueSignature === before ? entry.streak + 1 : 0;
      return { ok: true };
    } catch (error) {
      if (this.entries.get(entry.id) === entry) {
        entry.failure = {
          code: failureCode(error),
          message: failureMessage(error),
          cause: error,
          at: this.now(),
        };
        entry.streak += 1;
        if (entry.failure.code === 'NOT_FOUND') {
          // An authorized absence is a result; no earlier value stays readable as current.
          entry.value = undefined;
          entry.valueSignature = undefined;
          entry.observedAt = undefined;
        }
        console.warn(
          `[${this.options.method}] upstream collection failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
      }
      return { ok: false, error };
    } finally {
      if (entry.inflight === inflight) entry.inflight = undefined;
      this.publish(entry);
    }
  }

  /** Publish when the observed result, its freshness or its error changes; never while stopped. */
  private publish(entry: Entry<P, V>): void {
    if (this.stopped || this.entries.get(entry.id) !== entry) return;
    const signature = JSON.stringify([
      entry.observedAt,
      entry.failure?.code,
      entry.failure?.message,
      entry.valueSignature,
    ]);
    if (signature === entry.published) return;
    entry.published = signature;
    resourceRevisions.advance(this.resourceKey(entry.params));
  }
}
