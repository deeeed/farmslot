import { randomUUID } from 'node:crypto';

import type { MachineHealth, PRStatus, SlotEntity } from '@farmslot/protocol';
import {
  CHANGED_ENTITY_MAX_BYTES,
  RESOURCE_PUBLISH_INTERVAL_MS,
  type ResourceKey,
  resourceKeyId,
  type ResourceReadStamp,
} from '@farmslot/protocol/client-cache';
import type { ChangedEntity, ResourceChangedPayload } from '@farmslot/protocol/transport/events';

type Change = ResourceChangedPayload['changes'][number];

/** A maintained entity as its owner stores it: body, content version and UTF-8 JSON size. */
export type EntitySnapshot =
  | { family: 'slot'; version: string; bytes: number; entity: SlotEntity }
  | { family: 'upstream'; version: string; bytes: number; entity: PRStatus }
  | { family: 'node'; version: string; bytes: number; entity: MachineHealth };

/** Looks a maintained entity up; never derives one. */
export type EntityProvider = (key: ResourceKey) => EntitySnapshot | undefined;

function changedEntity(snapshot: EntitySnapshot, withBody: boolean): ChangedEntity {
  switch (snapshot.family) {
    case 'slot':
      return withBody
        ? { family: 'slot', version: snapshot.version, entity: snapshot.entity }
        : { family: 'slot', version: snapshot.version };
    case 'upstream':
      return withBody
        ? { family: 'upstream', version: snapshot.version, entity: snapshot.entity }
        : { family: 'upstream', version: snapshot.version };
    case 'node':
      return withBody
        ? { family: 'node', version: snapshot.version, entity: snapshot.entity }
        : { family: 'node', version: snapshot.version };
  }
}

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

  /** Entity-sync collection keys: their marker advances with membership or collection fields. */
  private readonly membershipRevisions = new Map<string, number>();
  private readonly entityCollections: Array<(key: ResourceKey) => boolean> = [];
  private readonly entityProviders = new Map<ResourceKey['family'], EntityProvider>();
  /** The version each per-entity key last published, so an unchanged body is not sent again. */
  private readonly publishedVersions = new Map<string, string>();

  /** One provider per family looks maintained entities up at publication; no I/O, no hashing. */
  setEntityProvider(family: ResourceKey['family'], provider: EntityProvider): void {
    this.entityProviders.set(family, provider);
  }

  /** Keys this predicate accepts carry their membership marker on every notification. */
  registerEntityCollection(isCollectionKey: (key: ResourceKey) => boolean): void {
    this.entityCollections.push(isCollectionKey);
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

  /** A collection's id set, order or non-entity fields changed: advance it and its marker. */
  advanceMembership(key: ResourceKey, kind: Change['kind'] = 'updated'): void {
    const id = resourceKeyId(key);
    this.membershipRevisions.set(id, (this.membershipRevisions.get(id) ?? 0) + 1);
    this.advance(key, kind);
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
          else
            for (const key of deadline.keys)
              // A time boundary changes a collection's non-entity fields (the fleet's `stale`),
              // which an entity-sync client reads again only when the marker moves.
              if (this.entityCollections.some((isCollection) => isCollection(key)))
                this.advanceMembership(key);
              else this.advance(key);
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
    /** Changed entities that fit the bound, by their place in `changes`. */
    const bodies: Array<{ index: number; snapshot: EntitySnapshot }> = [];
    for (const [id, change] of this.pending) {
      if (change.key.family !== family) continue;
      let entry: Change = change;
      if (change.kind === 'deleted') this.publishedVersions.delete(id);
      else {
        const snapshot = provider?.(change.key);
        if (snapshot) {
          // Every client current before this change holds the last published version: a body
          // that did not change, or exceeds the bound, is named by version only.
          const changed = this.publishedVersions.get(id) !== snapshot.version;
          this.publishedVersions.set(id, snapshot.version);
          if (changed && snapshot.bytes <= CHANGED_ENTITY_MAX_BYTES)
            bodies.push({ index: changes.length, snapshot });
          entry = { ...change, changedEntity: changedEntity(snapshot, false) };
        }
      }
      if (this.entityCollections.some((isCollection) => isCollection(change.key)))
        entry = { ...entry, membershipRevision: this.membershipRevisions.get(id) ?? 0 };
      changes.push(entry);
      this.pending.delete(id);
    }
    // Bodies are for small changes. A gateway start or a bulk change would attach more than a
    // full read returns: past the bound of one entity the publication names versions only, and
    // a client reads by ids what it lacks.
    const attached = bodies.reduce((sum, { snapshot }) => sum + snapshot.bytes, 0);
    if (attached <= CHANGED_ENTITY_MAX_BYTES)
      for (const { index, snapshot } of bodies)
        changes[index] = { ...changes[index], changedEntity: changedEntity(snapshot, true) };
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
    this.publishedVersions.clear();
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
