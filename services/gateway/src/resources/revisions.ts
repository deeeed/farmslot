import { randomUUID } from 'node:crypto';

import {
  RESOURCE_PUBLISH_INTERVAL_MS,
  type ResourceKey,
  resourceKeyId,
  type ResourceReadStamp,
} from '@farmslot/protocol/client-cache';
import type { ChangedEntity, ResourceChangedPayload } from '@farmslot/protocol/transport/events';

type Change = ResourceChangedPayload['changes'][number];

interface InvalidationDeadline {
  at: number;
  keys: ResourceKey[];
  timer: ReturnType<typeof setTimeout>;
}

/** Gateway-process counters. Writers advance after commit; no durable epoch or event log. */
export class GatewayResourceRevisions {
  readonly epoch = randomUUID();
  private readonly revisions = new Map<string, number>();
  private readonly pending = new Map<string, Change>();
  private readonly scheduled = new Map<
    ResourceKey['family'],
    ReturnType<typeof setTimeout> | null
  >();
  private publisher?: (payload: ResourceChangedPayload) => void;
  private readonly deadlines = new Map<string, InvalidationDeadline>();
  private readonly listeners = new Set<(payload: ResourceChangedPayload) => void>();

  /**
   * Per-key membership revision counters. Incremented by advanceMembership().
   * Attached to collection-key changes so entity-sync clients can detect data-only changes.
   */
  private readonly membershipRevisions = new Map<string, number>();

  /**
   * Per-family synchronous entity providers.
   * publish() calls the provider for per-entity keys to attach ChangedEntity inline.
   */
  private readonly entityProviders = new Map<
    ResourceKey['family'],
    (key: ResourceKey) => ChangedEntity | undefined
  >();

  /**
   * Register a synchronous entity provider for a resource family.
   * Called once at gateway startup per entity type. No I/O on the event loop.
   */
  setEntityProvider(
    family: ResourceKey['family'],
    provider: (key: ResourceKey) => ChangedEntity | undefined,
  ): void {
    this.entityProviders.set(family, provider);
  }

  /** Internal consumers share the same coalesced changes as connected clients. */
  subscribe(listener: (payload: ResourceChangedPayload) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setPublisher(publish: (payload: ResourceChangedPayload) => void): void {
    this.publisher = publish;
  }

  revision(key: ResourceKey): number {
    return this.revisions.get(resourceKeyId(key)) ?? 0;
  }

  sample(keys: readonly ResourceKey[]): ResourceReadStamp {
    return {
      epoch: this.epoch,
      dependencies: keys.map((key) => ({ key: { ...key }, revision: this.revision(key) })),
    };
  }

  notice(keys: readonly ResourceKey[]): ResourceChangedPayload {
    return {
      version: 1,
      epoch: this.epoch,
      changes: keys.map((key) => ({
        key: { ...key },
        revision: this.revision(key),
        kind: 'updated',
      })),
    };
  }

  advance(key: ResourceKey, kind: Change['kind'] = 'updated'): void {
    const id = resourceKeyId(key);
    const revision = this.revision(key) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error('Resource revision exhausted');
    this.revisions.set(id, revision);
    this.pending.set(id, { key: { ...key }, revision, kind });
    if (this.scheduled.has(key.family)) return;
    const interval = RESOURCE_PUBLISH_INTERVAL_MS[key.family] ?? 0;
    this.scheduled.set(key.family, null);
    if (interval) {
      const timer = setTimeout(() => this.publish(key.family), interval);
      timer.unref();
      this.scheduled.set(key.family, timer);
    } else queueMicrotask(() => this.publish(key.family));
  }

  /**
   * Advance a collection key AND increment its membershipRevision.
   * Use for slot-set changes (slot added or removed) and PR membership changes.
   * Entity-sync clients skip a versions read when the membershipRevision is unchanged.
   */
  advanceMembership(key: ResourceKey, kind: Change['kind'] = 'updated'): void {
    this.advance(key, kind);
    const id = resourceKeyId(key);
    this.membershipRevisions.set(id, (this.membershipRevisions.get(id) ?? 0) + 1);
  }

  /** The collection key's current membership marker; 0 before its first membership change. */
  membershipRevision(key: ResourceKey): number {
    return this.membershipRevisions.get(resourceKeyId(key)) ?? 0;
  }

  /** A time-dependent projection has no write at its boundary; its owner schedules that change. */
  scheduleInvalidation(ownerId: string, key: ResourceKey, at: number | undefined): void {
    this.scheduleDeadline(`${resourceKeyId(key)}\0${ownerId}`, [key], at);
  }

  /** One source deadline changes all its derived keys in the same publication turn. */
  scheduleInvalidations(
    ownerId: string,
    keys: readonly ResourceKey[],
    at: number | undefined,
  ): void {
    this.scheduleDeadline(`cohort\0${ownerId}`, keys, at);
  }

  private scheduleDeadline(id: string, keys: readonly ResourceKey[], at: number | undefined): void {
    const previous = this.deadlines.get(id);
    if (previous && previous.at === at) {
      previous.keys = keys.map((key) => ({ ...key }));
      return;
    }
    if (previous) clearTimeout(previous.timer);
    this.deadlines.delete(id);
    if (!keys.length || at === undefined || !Number.isFinite(at) || at <= Date.now()) return;
    const deadline: InvalidationDeadline = {
      at,
      keys: keys.map((key) => ({ ...key })),
      timer: setTimeout(
        () => {
          this.deadlines.delete(id);
          // Node timers have a signed 32-bit delay; a future timestamp can need another chunk.
          if (Date.now() < at) this.scheduleDeadline(id, deadline.keys, at);
          else for (const key of deadline.keys) this.advance(key);
        },
        Math.min(at - Date.now(), 2_147_483_647),
      ),
    };
    deadline.timer.unref();
    this.deadlines.set(id, deadline);
  }

  private publish(family: ResourceKey['family']): void {
    this.scheduled.delete(family);
    const changes: Change[] = [];
    const provider = this.entityProviders.get(family);
    for (const [id, change] of this.pending) {
      if (change.key.family !== family) continue;
      // Attach entity for per-entity keys (not collection keys, not deletions).
      const pushed = provider && change.kind !== 'deleted' ? provider(change.key) : undefined;
      // Attach membershipRevision for collection keys that have one.
      const membershipRev = this.membershipRevisions.get(id);
      const entry: Change = {
        ...change,
        ...(pushed ? { changedEntity: pushed } : {}),
        ...(membershipRev !== undefined ? { membershipRevision: membershipRev } : {}),
      };
      changes.push(entry);
      this.pending.delete(id);
    }
    // Before server initialization there are no client sockets to notify.
    if (changes.length) {
      const payload: ResourceChangedPayload = { version: 1, epoch: this.epoch, changes };
      this.publisher?.(payload);
      for (const listener of this.listeners) listener(payload);
    }
  }

  clearKeyForTests(key: ResourceKey): void {
    const id = resourceKeyId(key);
    this.revisions.delete(id);
    this.pending.delete(id);
  }

  dispose(): void {
    this.listeners.clear();
    for (const { timer } of this.deadlines.values()) clearTimeout(timer);
    this.deadlines.clear();
    for (const timer of this.scheduled.values()) if (timer) clearTimeout(timer);
    this.pending.clear();
    this.scheduled.clear();
    this.membershipRevisions.clear();
    this.entityProviders.clear();
  }
}

export const resourceRevisions = new GatewayResourceRevisions();

/** This exact helper also brackets the websocket server's existing read dispatch. */
export async function readWithResourceState<T>(
  keys: readonly ResourceKey[],
  read: () => Promise<T>,
  revisions = resourceRevisions,
) {
  const resourceState = revisions.sample(keys);
  return { payload: await read(), resourceState };
}
