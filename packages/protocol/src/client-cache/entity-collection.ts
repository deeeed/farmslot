/**
 * Generic entity collection for entity-sync (ADR-071 Amendment 3).
 *
 * Generalises the run-list versions+ids pattern for fleet.status, decision.list
 * and pr.list. Each collection manages a Map of entities with content-hash
 * versions; a versions read and ids catch-up keep it current.
 */

export interface EntityVersionEntry {
  id: string;
  version: string;
}

/** Shared page shape for ids reads across fleet, decisions and PRs. */
export interface EntitySyncPage<T> {
  entities: T[];
  versions: EntityVersionEntry[];
}

export interface EntityCollectionOptions<T> {
  /** Extract the stable entity id from an entity. */
  idOf(entity: T): string;
  /** Sort comparator for the assembled array. */
  sort(a: T, b: T): number;
  /**
   * Fetch the versions list (called with { versions: true }).
   * Returns the id/version pairs; non-entity fields are caller-managed.
   */
  fetchVersions(signal: AbortSignal): Promise<{ versions: EntityVersionEntry[] }>;
  /**
   * Fetch a page of entities by id.
   * Returns entities (possibly fewer than requested) plus their versions.
   */
  fetchPage(ids: string[], signal: AbortSignal): Promise<EntitySyncPage<T>>;
  /**
   * Called when catch-up progress changes (each page landing).
   * Consumers use this to update catchUpProgress on the owning query state.
   */
  onProgress?(done: number, total: number): void;
}

const ENTITY_SYNC_FIRST_PAGE_MIN = 20;

export class EntityCollection<T> {
  /** Id → version from the last versions read. Set means "these are all the ids". */
  private listed: Map<string, string> | undefined;
  /** Id → {entity, version} held in memory. */
  private readonly rows = new Map<string, { entity: T; version: string }>();
  private inflight?: {
    promise: Promise<void>;
    controller: AbortController;
  };

  constructor(private readonly options: EntityCollectionOptions<T>) {}

  /** True when a versions read has been completed at least once. */
  get held(): boolean {
    return this.listed !== undefined;
  }

  /** True when every listed id has its entity at the listed version. */
  get complete(): boolean {
    if (!this.listed) return false;
    for (const [id, version] of this.listed) {
      const row = this.rows.get(id);
      if (!row || row.version !== version) return false;
    }
    return true;
  }

  /**
   * Run a versions read + ids catch-up. No-ops if already in-flight.
   * Pass `visibleCount` to size the first page to what is on screen.
   */
  async refresh(opts?: { visibleCount?: number; visibleIds?: string[] }): Promise<void> {
    const running = this.inflight;
    if (running) return running.promise;
    const controller = new AbortController();
    const inflight = {
      controller,
      promise: this.read(opts ?? {}, controller.signal).finally(() => {
        if (this.inflight === inflight) this.inflight = undefined;
      }),
    };
    this.inflight = inflight;
    return inflight.promise;
  }

  private async read(
    opts: { visibleCount?: number; visibleIds?: string[] },
    signal: AbortSignal,
  ): Promise<void> {
    const { versions } = await this.options.fetchVersions(signal);
    if (signal.aborted) throw new Error('Entity collection read superseded');

    const listed = new Map(versions.map(({ id, version }) => [id, version]));
    // Prune rows not in the new listing.
    for (const id of [...this.rows.keys()]) {
      if (!listed.has(id)) this.rows.delete(id);
    }
    this.listed = listed;

    // Build the ids-to-fetch list, prioritising visible entities.
    const toFetch = versions
      .filter(({ id, version }) => {
        const row = this.rows.get(id);
        return !row || row.version !== version;
      })
      .map(({ id }) => id);

    if (toFetch.length === 0) return;

    // Sort: visible first, then remainder.
    const visibleSet = new Set(opts.visibleIds ?? []);
    const firstPageSize = Math.max((opts.visibleCount ?? 0) + 5, ENTITY_SYNC_FIRST_PAGE_MIN);
    const prioritised = [
      ...toFetch.filter((id) => visibleSet.has(id)),
      ...toFetch.filter((id) => !visibleSet.has(id)),
    ];

    this.options.onProgress?.(0, toFetch.length);

    let remaining = [...prioritised];
    let done = 0;
    let firstPage = true;

    while (remaining.length > 0) {
      const ask = firstPage ? remaining.slice(0, firstPageSize) : remaining;
      firstPage = false;
      const page = await this.options.fetchPage(ask, signal);
      if (signal.aborted) throw new Error('Entity collection read superseded');

      for (let i = 0; i < page.entities.length; i++) {
        const entity = page.entities[i];
        const id = this.options.idOf(entity);
        if (!listed.has(id)) continue;
        // Skip if the row is already at the currently-listed version.
        // applyEntity (from a push) may have delivered a newer version while this page
        // was in-flight: listed snapshot said a:v1, push delivered a@v2, now page
        // returns a@v1 — do not regress the row back to v1.
        const currentListedVersion = this.listed?.get(id);
        const currentRow = this.rows.get(id);
        if (
          currentRow !== undefined &&
          currentListedVersion !== undefined &&
          currentRow.version === currentListedVersion
        ) {
          continue;
        }
        const v = page.versions.find((e) => e.id === id)?.version ?? listed.get(id) ?? '';
        this.rows.set(id, { entity, version: v });
      }

      const served = new Set(page.entities.map((e) => this.options.idOf(e)));
      remaining = remaining.filter((id) => !served.has(id));
      done += served.size;
      this.options.onProgress?.(Math.min(done, toFetch.length), toFetch.length);
    }
  }

  /**
   * Apply a pushed entity from resource.changed.
   * No-ops if the entity is not in the listed set (speculative: queues a versions read).
   */
  applyEntity(id: string, entity: T, version: string): void {
    this.rows.set(id, { entity, version });
    // Update listed version if we have a listing.
    if (this.listed) {
      this.listed.set(id, version);
    }
  }

  /** Apply a deletion from resource.changed kind=deleted. */
  applyDeleted(id: string): void {
    this.rows.delete(id);
    this.listed?.delete(id);
  }

  /** Assembled sorted array; undefined when no versions read has completed. */
  assemble(): T[] | undefined {
    if (!this.listed) return undefined;
    const entities: T[] = [];
    for (const id of this.listed.keys()) {
      const row = this.rows.get(id);
      if (row) entities.push(row.entity);
    }
    return entities.sort(this.options.sort);
  }

  /** The id/version map from the last versions read. */
  listedVersions(): Map<string, string> | undefined {
    return this.listed ? new Map(this.listed) : undefined;
  }

  /**
   * Check whether a collection change with the given membershipRevision requires
   * a versions read. Returns true when the client must re-read (membership changed
   * or no prior listing).
   */
  needsVersionsRead(incomingMembershipRevision: number | undefined): boolean {
    if (!this.listed) return true;
    if (incomingMembershipRevision === undefined) return true;
    // If we have a stored membershipRevision and it matches, skip.
    return incomingMembershipRevision !== this._lastMembershipRevision;
  }

  private _lastMembershipRevision: number | undefined;

  storeMembershipRevision(rev: number): void {
    this._lastMembershipRevision = rev;
  }

  /** Forget everything: new store, new connection, refusal. */
  clear(): void {
    this.inflight?.controller.abort();
    this.inflight = undefined;
    this.listed = undefined;
    this.rows.clear();
    this._lastMembershipRevision = undefined;
  }

  /** Abandon in-flight read; keep held data. */
  abort(): void {
    this.inflight?.controller.abort();
    this.inflight = undefined;
    // Don't clear listed — data is still valid, just not being updated.
  }
}
