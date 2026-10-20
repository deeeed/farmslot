import { randomUUID } from 'node:crypto';

import {
  RESOURCE_PUBLISH_INTERVAL_MS,
  type ResourceKey,
  resourceKeyId,
  type ResourceReadStamp,
} from '@farmslot/protocol/client-cache';
import type { ResourceChangedPayload } from '@farmslot/protocol/transport/events';

type Change = ResourceChangedPayload['changes'][number];

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

  private publish(family: ResourceKey['family']): void {
    this.scheduled.delete(family);
    const changes: Change[] = [];
    for (const [id, change] of this.pending) {
      if (change.key.family !== family) continue;
      changes.push(change);
      this.pending.delete(id);
    }
    // Before server initialization there are no client sockets to notify.
    if (changes.length && this.publisher)
      this.publisher({ version: 1, epoch: this.epoch, changes });
  }

  clearKeyForTests(key: ResourceKey): void {
    const id = resourceKeyId(key);
    this.revisions.delete(id);
    this.pending.delete(id);
  }

  dispose(): void {
    for (const timer of this.scheduled.values()) if (timer) clearTimeout(timer);
    this.pending.clear();
    this.scheduled.clear();
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
