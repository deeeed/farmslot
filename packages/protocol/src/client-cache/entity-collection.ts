/**
 * Entity collection for entity sync (ADR-071 Amendment 3): fleet slots and PR rows held as
 * entities with content versions, kept current by pushes, a versions read and ids pages.
 *
 * Rules:
 * - Rows stay displayed across reconnects; after every connection or epoch change the listing is
 *   verified by a versions read before the collection counts as current.
 * - A push or deletion that lands after a read was sent wins over that read's entry for the id.
 * - A change without a usable body reads that id; a deletion removes it.
 * - An id the versions read listed but the ids page did not return ends in a fresh versions read,
 *   at most twice per sync, never a repeated page.
 */

export interface EntityVersionEntry {
  id: string;
  version: string;
}

/** Shared page shape for ids reads across fleet and PRs. */
export interface EntitySyncPage<T> {
  entities: T[];
  versions: EntityVersionEntry[];
}

/** A versions read: the listing and the membership marker it reflects, when the gateway says. */
export interface EntityVersionsReply {
  versions: EntityVersionEntry[];
  membershipRevision?: number;
}

export interface EntityCollectionOptions<T> {
  idOf(entity: T): string;
  /** Shape, identity and version check for every untrusted body. */
  accept(value: unknown, id: string, version: string): value is T;
  fetchVersions(signal: AbortSignal): Promise<EntityVersionsReply>;
  fetchPage(ids: string[], signal: AbortSignal): Promise<EntitySyncPage<unknown>>;
  /** Called after each ids page is applied, with entities received so far and the total asked. */
  onPage?(done: number, total: number): void;
}

/** A row as the store keeps it. */
export interface EntityRow<T> {
  id: string;
  version: string;
  entity: T;
}

const FIRST_PAGE = 20;
/** Fresh versions reads after an ids page could not serve a listed id, per sync. */
const MAX_RECONCILES = 2;
/** Sync passes per call: new work arriving during a pass is picked up, but never forever. */
const MAX_PASSES = 6;

function superseded(): Error {
  return Object.assign(new Error('Entity collection read superseded'), {
    code: 'RESOURCE_READ_SUPERSEDED',
  });
}

export class EntityCollection<T> {
  /** Every row held, displayed or not yet verified. */
  private readonly rows = new Map<string, { entity: T; version: string }>();
  /** The gateway's id → version listing, kept current by pushes; undefined before the first read. */
  private listed?: Map<string, string>;
  /** The listing was confirmed by a versions read on the current connection. */
  private verified = false;
  /** The membership marker the listing reflects, and the highest one notified since. */
  private listedMarker?: number;
  private seenMarker?: number;
  /** A collection change came without a marker: only a versions read can tell. */
  private markerUnknown = false;
  /** Ids whose change came without a usable body. */
  private readonly pending = new Set<string>();
  /** Last local change per id, so a reply sent before it cannot overwrite it. */
  private readonly touched = new Map<string, number>();
  private sequence = 0;
  /** Rows changed or removed since the store last took them. */
  private readonly unstored = new Set<string>();
  private readonly unstoredDeletes = new Set<string>();
  private inflight?: { promise: Promise<boolean>; controller: AbortController };

  constructor(private readonly options: EntityCollectionOptions<T>) {}

  /** The collection holds rows or a listing to show. */
  get held(): boolean {
    return this.listed !== undefined || this.rows.size > 0;
  }

  /** Verified on this connection, nothing notified since is unread, every listed row is held. */
  get current(): boolean {
    return this.verified && !this.membershipStale() && this.pending.size === 0 && this.complete();
  }

  /** True while a sync is running. */
  get syncing(): boolean {
    return this.inflight !== undefined;
  }

  private membershipStale(): boolean {
    return (
      this.markerUnknown ||
      (this.seenMarker !== undefined &&
        (this.listedMarker === undefined || this.seenMarker > this.listedMarker))
    );
  }

  private complete(): boolean {
    if (!this.listed) return false;
    for (const [id, version] of this.listed)
      if (this.rows.get(id)?.version !== version) return false;
    return true;
  }

  private touch(id: string): void {
    this.touched.set(id, ++this.sequence);
  }

  private changedSince(id: string, start: number): boolean {
    return (this.touched.get(id) ?? 0) > start;
  }

  /**
   * Brings the collection current: a versions read when the listing is unverified or membership
   * moved, then ids pages for what is missing or changed. Resolves true when current.
   */
  sync(): Promise<boolean> {
    if (this.inflight) return this.inflight.promise;
    const controller = new AbortController();
    const inflight = {
      controller,
      promise: this.run(controller.signal).finally(() => {
        if (this.inflight === inflight) this.inflight = undefined;
      }),
    };
    this.inflight = inflight;
    return inflight.promise;
  }

  private async run(signal: AbortSignal): Promise<boolean> {
    let reconciles = 0;
    let reconcile = false;
    for (let pass = 0; pass < MAX_PASSES && !this.current; pass++) {
      if (!this.verified || !this.listed || this.membershipStale() || reconcile) {
        await this.readVersions(signal);
        reconcile = false;
      }
      const missing = await this.readPages(signal);
      if (missing && reconciles < MAX_RECONCILES) {
        reconciles++;
        reconcile = true;
      } else if (missing) break;
    }
    return this.current;
  }

  private async readVersions(signal: AbortSignal): Promise<void> {
    const start = this.sequence;
    const markerAtStart = this.seenMarker;
    const reply = await this.options.fetchVersions(signal);
    if (signal.aborted) throw superseded();
    const replied = new Map<string, string>();
    for (const entry of Array.isArray(reply.versions) ? reply.versions : [])
      if (entry && typeof entry.id === 'string' && typeof entry.version === 'string')
        replied.set(entry.id, entry.version);
    // The reply's order is the gateway's; a change after the request was sent wins over its entry.
    const listed = new Map<string, string>();
    for (const [id, version] of replied) {
      const row = this.rows.get(id);
      if (!this.changedSince(id, start)) listed.set(id, version);
      // Pushed after the request: a member at the pushed version.
      else if (row) listed.set(id, row.version);
      // Changed without a usable body: a member, read below. A deletion stays deleted.
      else if (this.pending.has(id)) listed.set(id, version);
    }
    // Added by a push after the request: a member the reply could not list.
    for (const [id, row] of this.rows)
      if (this.changedSince(id, start) && !listed.has(id)) listed.set(id, row.version);
    for (const id of [...this.rows.keys()]) {
      if (listed.has(id)) continue;
      this.rows.delete(id);
      this.unstored.delete(id);
      this.unstoredDeletes.add(id);
    }
    for (const id of [...this.pending]) if (!listed.has(id)) this.pending.delete(id);
    this.listed = listed;
    this.verified = true;
    this.markerUnknown = false;
    const marker = reply.membershipRevision ?? markerAtStart;
    this.listedMarker = marker;
    if (marker !== undefined && (this.seenMarker === undefined || marker > this.seenMarker))
      this.seenMarker = marker;
  }

  /** Reads every listed id whose row is missing or differs. Returns true if a listed id was not served. */
  private async readPages(signal: AbortSignal): Promise<boolean> {
    const listed = this.listed;
    if (!listed) return false;
    let ask = [...listed]
      .filter(([id, version]) => this.pending.has(id) || this.rows.get(id)?.version !== version)
      .map(([id]) => id);
    const total = ask.length;
    if (total === 0) return false;
    let done = 0;
    let missing = false;
    let first = true;
    while (ask.length > 0) {
      const request = first ? ask.slice(0, FIRST_PAGE) : ask;
      first = false;
      const start = this.sequence;
      const page = await this.options.fetchPage(request, signal);
      if (signal.aborted) throw superseded();
      const served = new Set<string>();
      const versions = Array.isArray(page.versions) ? page.versions : [];
      const entities = Array.isArray(page.entities) ? page.entities : [];
      versions.forEach((entry, index) => {
        if (!entry || typeof entry.id !== 'string' || !request.includes(entry.id)) return;
        served.add(entry.id);
        // A push after this page was sent is newer than the page.
        if (this.changedSince(entry.id, start) || !this.listed?.has(entry.id)) return;
        const entity = entities[index];
        if (!this.options.accept(entity, entry.id, entry.version)) {
          served.delete(entry.id);
          return;
        }
        this.rows.set(entry.id, { entity, version: entry.version });
        // A page is newer than the listing it followed.
        this.listed.set(entry.id, entry.version);
        this.pending.delete(entry.id);
        this.unstored.add(entry.id);
        this.unstoredDeletes.delete(entry.id);
      });
      // Pages keep request order and stop at a byte cap: ids before the last served one that
      // were not served are gone or unusable; the rest are asked next.
      let last = -1;
      request.forEach((id, index) => {
        if (served.has(id)) last = index;
      });
      const unserved = (last < 0 ? request : request.slice(0, last + 1)).filter(
        (id) => !served.has(id) && !this.changedSince(id, start),
      );
      if (unserved.length) missing = true;
      const answered = new Set(last < 0 ? request : request.slice(0, last + 1));
      ask = ask.filter((id) => !answered.has(id));
      done += served.size;
      this.options.onPage?.(Math.min(done, total), total);
    }
    return missing;
  }

  /** A pushed body. Returns false when it was not admitted; that id is then read. */
  applyEntity(id: string, value: unknown, version: string): boolean {
    this.touch(id);
    if (!this.options.accept(value, id, version)) {
      this.pending.add(id);
      return false;
    }
    this.rows.set(id, { entity: value, version });
    this.listed?.set(id, version);
    this.pending.delete(id);
    this.unstored.add(id);
    this.unstoredDeletes.delete(id);
    return true;
  }

  /** A change that names only the version: nothing to do when that version is held. */
  applyVersion(id: string, version: string): void {
    this.touch(id);
    if (this.rows.get(id)?.version === version) {
      this.listed?.set(id, version);
      this.pending.delete(id);
    } else this.pending.add(id);
  }

  /** A change with no body at all: read that id. */
  applyUnknown(id: string): void {
    this.touch(id);
    this.pending.add(id);
  }

  applyDeleted(id: string): void {
    this.touch(id);
    this.rows.delete(id);
    this.listed?.delete(id);
    this.pending.delete(id);
    this.unstored.delete(id);
    this.unstoredDeletes.add(id);
  }

  /** A collection change: its marker says whether membership or collection fields moved. */
  noteMembership(marker: number | undefined): void {
    if (marker === undefined || !Number.isSafeInteger(marker)) {
      this.markerUnknown = true;
      return;
    }
    if (this.seenMarker === undefined || marker > this.seenMarker) this.seenMarker = marker;
  }

  /** Stored rows from a previous session: admitted ones are shown, unverified, until a versions read. */
  hydrate(rows: ReadonlyArray<{ id: string; version: string; body?: unknown }>): void {
    for (const row of rows) {
      if (this.rows.has(row.id) || !this.options.accept(row.body, row.id, row.version)) continue;
      this.rows.set(row.id, { entity: row.body, version: row.version });
    }
  }

  /** Rows in the gateway's order: the listing's members once one exists, else every held row. */
  assemble(): T[] | undefined {
    if (!this.held) return undefined;
    if (!this.listed) return [...this.rows.values()].map((row) => row.entity);
    const entities: T[] = [];
    for (const id of this.listed.keys()) {
      const row = this.rows.get(id);
      if (row) entities.push(row.entity);
    }
    return entities;
  }

  /** Rows changed and removed since the last call, for one store merge. */
  takeUnstored(): { upserts: EntityRow<T>[]; deletes: string[] } {
    const upserts = [...this.unstored].flatMap((id) => {
      const row = this.rows.get(id);
      return row ? [{ id, version: row.version, entity: row.entity }] : [];
    });
    const deletes = [...this.unstoredDeletes];
    this.unstored.clear();
    this.unstoredDeletes.clear();
    return { upserts, deletes };
  }

  /** A new connection or epoch: keep the rows on screen, verify them before they count as current. */
  unverify(): void {
    this.inflight?.controller.abort();
    this.inflight = undefined;
    this.verified = false;
    this.listedMarker = undefined;
    this.seenMarker = undefined;
    this.markerUnknown = false;
    this.pending.clear();
  }

  /** Forget everything: a new store, owner or refusal. */
  clear(): void {
    this.unverify();
    this.rows.clear();
    this.listed = undefined;
    this.touched.clear();
    this.unstored.clear();
    this.unstoredDeletes.clear();
  }
}
