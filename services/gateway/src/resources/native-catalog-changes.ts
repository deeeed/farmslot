import { randomUUID } from 'node:crypto';
import { existsSync, type FSWatcher, lstatSync, watch } from 'node:fs';
import { dirname } from 'node:path';

/** Internal source notices. The server derives and authorizes private keys; never RPC params. */
export type NativeCatalogChange =
  | {
      scope: 'owner';
      ownerId: string;
      ownerGeneration: number;
      reason: 'updated' | 'failed' | 'recovered';
    }
  | { scope: 'all'; reason: 'catalog' };

export class NativeCatalogChanges {
  private readonly listeners = new Set<(change: NativeCatalogChange) => void>();

  subscribe(listener: (change: NativeCatalogChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  preferencesChanged(
    ownerId: string,
    ownerGeneration = 0,
    reason: 'updated' | 'failed' | 'recovered' = 'updated',
  ): void {
    for (const listener of this.listeners)
      listener({ scope: 'owner', ownerId, ownerGeneration, reason });
  }

  catalogChanged(): void {
    for (const listener of this.listeners) listener({ scope: 'all', reason: 'catalog' });
  }
}

export const nativeCatalogChanges = new NativeCatalogChanges();

export interface NativeCatalogKey {
  family: 'native-session';
  scope: 'owner';
  ownerId: string;
}

export interface NativeCatalogInterest {
  method: string;
  key: NativeCatalogKey;
  readerGeneration: number;
}

/** Routing only, never authorization. The existing exact private-key filter still runs before send.
 * No revision for B is advanced by A's preference notice, including a reused principal ID. */
export function changedNativeCatalogKeys(
  change: NativeCatalogChange,
  interests: Iterable<NativeCatalogInterest>,
): NativeCatalogKey[] {
  const keys = new Map<string, NativeCatalogKey>();
  for (const interest of interests) {
    if (interest.method !== 'native.session.catalog') continue;
    const key = interest.key;
    if (key.family !== 'native-session' || key.scope !== 'owner') continue;
    if (
      change.scope === 'owner' &&
      (key.ownerId !== change.ownerId || interest.readerGeneration !== change.ownerGeneration)
    )
      continue;
    keys.set(key.ownerId, key);
  }
  return [...keys.values()];
}

export interface NativeCatalogSourceReceipt {
  incarnation: string;
  revision: number;
  ready: boolean;
}

export class NativeCatalogSourceUnavailable extends Error {
  readonly code = 'NATIVE_SOURCE_UNAVAILABLE';
  constructor() {
    super('Native catalog preferences unavailable. Retry after source recovery.');
  }
}

/** One ref-counted source per active preference home. It watches the nearest existing parent,
 * reattaches after replacement/removal, and closes synchronously when its last connection leaves. */
export class NativeCatalogPreferenceSource {
  private watcher?: FSWatcher;
  private watchedDirectory?: string;
  private fingerprint?: string;
  private watchedIdentity?: string;
  private failed = false;
  private receipt: NativeCatalogSourceReceipt = {
    incarnation: randomUUID(),
    revision: 0,
    ready: false,
  };
  private closed = false;

  constructor(
    private readonly file: string,
    private readonly readFingerprint: () => string,
    private readonly changed: (reason: 'updated' | 'failed' | 'recovered') => void,
  ) {}

  /** Also used at both sides of the catalog route to close the fs-event delivery window. */
  sample(): NativeCatalogSourceReceipt {
    if (this.closed) throw new NativeCatalogSourceUnavailable();
    let next: string;
    try {
      this.arm();
      next = this.readFingerprint();
    } catch {
      // A failed filesystem read/watch is a visible source failure, not a new empty preference set.
      this.fail();
      throw new NativeCatalogSourceUnavailable();
    }
    const recovered = !this.receipt.ready;
    this.failed = false;
    const changed = this.fingerprint !== undefined && this.fingerprint !== next;
    this.fingerprint = next;
    this.receipt = {
      ...this.receipt,
      ready: true,
      incarnation: recovered ? randomUUID() : this.receipt.incarnation,
      revision: this.receipt.revision + (recovered || changed ? 1 : 0),
    };
    if (recovered || changed) this.changed(recovered ? 'recovered' : 'updated');
    return { ...this.receipt };
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = undefined;
  }

  private arm(): void {
    let directory = dirname(this.file);
    while (!existsSync(directory)) {
      const parent = dirname(directory);
      if (parent === directory) throw new NativeCatalogSourceUnavailable();
      directory = parent;
    }
    const stat = lstatSync(directory);
    const identity = `${stat.dev}:${stat.ino}`;
    if (this.watcher && this.watchedDirectory === directory && this.watchedIdentity === identity)
      return;
    const replaced = this.watcher !== undefined;
    this.watcher?.close();
    if (replaced) this.receipt = { ...this.receipt, incarnation: randomUUID() };
    const watcher = watch(directory, () => {
      if (this.closed || this.watcher !== watcher) return;
      try {
        this.sample();
      } catch (error) {
        // sample published SOURCE_UNAVAILABLE. Only that expected source failure is recoverable.
        if (!(error instanceof NativeCatalogSourceUnavailable)) throw error;
      }
    });
    watcher.on('error', () => {
      if (this.closed || this.watcher !== watcher) return;
      watcher.close();
      this.watcher = undefined;
      this.fail();
    });
    this.watcher = watcher;
    this.watchedDirectory = directory;
    this.watchedIdentity = identity;
  }

  private fail(): void {
    if (this.failed) return;
    this.failed = true;
    this.receipt = { ...this.receipt, ready: false, revision: this.receipt.revision + 1 };
    this.changed('failed');
  }
}
