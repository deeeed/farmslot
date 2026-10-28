import { isActiveListRun, normalizeRunTags, type Run } from '../contracts/runs.js';
import { Methods } from '../rpc/registry.js';
import type { RunListParams, RunListResult } from '../rpc/run.js';
import {
  runListPage,
  type RunListProjection,
  runListProjection,
  sortRunList,
} from '../runs/run-list-filter.js';

import type { ResourceReadStamp } from './keys.js';
import { resourceQuery } from './registry.js';
import type { ResourceRowsMerge, StoredResourceRows } from './store.js';
import type { ResourceReadResult } from './types.js';

/** The run.list `{ versions: true }` entry: it owns the one shared row collection. */
export const RUN_LIST_COLLECTION_ID = resourceQuery(Methods.RUN_LIST, { versions: true }).id;

/** The owner's own data; the rows hold the version index, projections and bodies. */
export interface RunListCollectionData {
  totalCount: number;
  summaryMeta?: RunListResult['summaryMeta'];
  familySummaries?: RunListResult['familySummaries'];
  projectAnalytics?: RunListResult['projectAnalytics'];
}

export type RunListSummaryFlags = Pick<
  RunListParams,
  'includeFamilySummaries' | 'includeProjectAnalytics'
>;

export interface RunListCollectionOptions {
  request(params: RunListParams, signal: AbortSignal): Promise<ResourceReadResult<RunListResult>>;
  /** Writes one merge, fenced to the current store; a store without rows keeps the collection in memory. */
  persist(merge: ResourceRowsMerge): Promise<void>;
  /** Decision 1: the bodies the store keeps, active runs first, then newest. */
  maxBodyBytes: number;
}

interface HeldRow {
  version: string;
  projection: RunListProjection;
  body?: Run;
  projectionBytes: number;
  bodyBytes: number;
  storedBody: boolean;
}

const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

/** A view whose summaries the version reply's, computed over every live run, can answer. */
function unfiltered(params: RunListParams): boolean {
  return !(
    params.status ||
    params.active ||
    params.flowType ||
    params.project ||
    params.prNumber != null ||
    params.familyId ||
    params.lane ||
    params.variant !== undefined ||
    params.outcome ||
    params.dateFrom ||
    params.dateTo ||
    params.search ||
    normalizeRunTags(params.tags).length > 0
  );
}

/** The summary flags a view needs from the version reply; filtered views read their own. */
export function runListSummaryFlags(params: RunListParams): RunListSummaryFlags {
  return unfiltered(params)
    ? {
        ...(params.includeFamilySummaries ? { includeFamilySummaries: true } : {}),
        ...(params.includeProjectAnalytics ? { includeProjectAnalytics: true } : {}),
      }
    : {};
}

/** True for the version list itself and its catch-up pages, which no view answers. */
export function isRunListCollectionRead(params: unknown): boolean {
  return (
    !!params &&
    typeof params === 'object' &&
    (Reflect.get(params, 'versions') !== undefined || Reflect.get(params, 'ids') !== undefined)
  );
}

/**
 * Version lists rules 3, 4 and 6: one shared collection of every live run, read by a version list
 * and catch-up pages of changed and missing ids, merged into the store a page at a time.
 */
export class RunListCollection {
  private order: string[] = [];
  private readonly rows = new Map<string, HeldRow>();
  /** Rows removed from memory whose deletion no merge has stored yet. */
  private readonly unstoredDeletes = new Set<string>();
  private listed?: Map<string, string>;
  private data?: RunListCollectionData;
  private dataFlags: RunListSummaryFlags = {};
  private inflight?: {
    flags: RunListSummaryFlags;
    promise: Promise<void>;
    controller: AbortController;
  };
  resourceState?: ResourceReadStamp;
  observedAt?: number;

  constructor(private readonly options: RunListCollectionOptions) {}

  /** Holds a collection, from a version reply or the store. */
  get held(): boolean {
    return this.data !== undefined;
  }

  /** Every id the last version reply listed has its body at the listed version. */
  get complete(): boolean {
    if (!this.listed) return false;
    for (const [id, version] of this.listed) {
      const row = this.rows.get(id);
      if (!row?.body || row.version !== version) return false;
    }
    return true;
  }

  /** The last version reply carried every summary `flags` asks for. */
  serves(flags: RunListSummaryFlags): boolean {
    return (
      (!flags.includeFamilySummaries || !!this.dataFlags.includeFamilySummaries) &&
      (!flags.includeProjectAnalytics || !!this.dataFlags.includeProjectAnalytics)
    );
  }

  /** One versions read and its catch-up at a time; a read lacking needed summaries is followed by one. */
  async refresh(flags: RunListSummaryFlags): Promise<void> {
    const covers = (held: RunListSummaryFlags) =>
      (!flags.includeFamilySummaries || held.includeFamilySummaries) &&
      (!flags.includeProjectAnalytics || held.includeProjectAnalytics);
    const running = this.inflight;
    if (running && covers(running.flags)) return running.promise;
    if (running) await running.promise.catch(() => undefined);
    if (this.inflight && covers(this.inflight.flags)) return this.inflight.promise;
    const controller = new AbortController();
    const inflight = {
      flags,
      controller,
      promise: this.read(flags, controller.signal).finally(() => {
        if (this.inflight === inflight) this.inflight = undefined;
      }),
    };
    this.inflight = inflight;
    return inflight.promise;
  }

  private async read(flags: RunListSummaryFlags, signal: AbortSignal): Promise<void> {
    const reply = await this.options.request({ versions: true, ...flags }, signal);
    if (signal.aborted) throw new Error('Run list read superseded');
    const result = reply.data;
    const versions = result.versions ?? [];
    const listed = new Map(versions.map(({ id, version }) => [id, version]));
    // Rule 3: only the version reply decides which rows exist.
    for (const id of [...this.rows.keys()].filter((id) => !listed.has(id))) {
      this.rows.delete(id);
      this.unstoredDeletes.add(id);
    }
    this.order = versions.map(({ id }) => id);
    this.listed = listed;
    this.data = {
      totalCount: result.totalCount,
      ...(result.summaryMeta ? { summaryMeta: result.summaryMeta } : {}),
      ...(result.familySummaries ? { familySummaries: result.familySummaries } : {}),
      ...(result.projectAnalytics ? { projectAnalytics: result.projectAnalytics } : {}),
    };
    this.dataFlags = flags;
    this.resourceState = reply.resourceState;
    let ask = versions
      .filter(({ id, version }) => {
        const row = this.rows.get(id);
        return !row?.body || row.version !== version;
      })
      .map(({ id }) => id);
    let missing: string[] = [];
    let retried = false;
    let committed = false;
    // Rule 4: pages continue after the last served id; ids at or before it that were not served
    // are asked once more, then left for the next version reply.
    while (ask.length > 0) {
      const page = (await this.options.request({ ids: ask }, signal)).data;
      if (signal.aborted) throw new Error('Run list read superseded');
      const served: string[] = [];
      page.runs.forEach((run, index) => {
        if (!listed.has(run.id)) return;
        const pageVersion = page.versions?.[index];
        this.put(
          run,
          pageVersion?.id === run.id ? pageVersion.version : (listed.get(run.id) ?? ''),
        );
        served.push(run.id);
      });
      const last = served.length > 0 ? ask.lastIndexOf(served[served.length - 1]) : -1;
      const servedIds = new Set(served);
      missing.push(...(last < 0 ? ask : ask.slice(0, last + 1)).filter((id) => !servedIds.has(id)));
      ask = last < 0 ? [] : ask.slice(last + 1);
      await this.commit(served);
      committed = true;
      if (ask.length === 0 && !retried && missing.length > 0) {
        retried = true;
        ask = missing;
        missing = [];
      }
    }
    if (!committed) await this.commit([]);
  }

  private put(run: Run, version: string): void {
    const projection = runListProjection(run);
    this.rows.set(run.id, {
      version,
      projection,
      body: run,
      projectionBytes: jsonBytes(projection),
      bodyBytes: jsonBytes(run),
      storedBody: false,
    });
  }

  /** Writes `changed`, every row whose stored body the bound now keeps or drops, and deletions. */
  private async commit(changed: readonly string[]): Promise<void> {
    const ranked = [...this.rows.entries()]
      .filter(([, row]) => row.body)
      .sort(
        ([, a], [, b]) =>
          Number(isActiveListRun(b.projection)) - Number(isActiveListRun(a.projection)) ||
          Date.parse(b.projection.createdAt) - Date.parse(a.projection.createdAt),
      );
    const keep = new Set<string>();
    let room = this.options.maxBodyBytes;
    for (const [id, row] of ranked) {
      if (row.bodyBytes > room) break;
      keep.add(id);
      room -= row.bodyBytes;
    }
    const write = new Set(changed);
    for (const [id, row] of this.rows) if (row.storedBody !== keep.has(id)) write.add(id);
    const upserts = [...write].flatMap((id) => {
      const row = this.rows.get(id);
      if (!row) return [];
      row.storedBody = keep.has(id);
      return [
        {
          id,
          version: row.version,
          projection: row.projection,
          ...(row.storedBody ? { body: row.body } : {}),
          bytes: row.projectionBytes + (row.storedBody ? row.bodyBytes : 0),
        },
      ];
    });
    const deletes = [...this.unstoredDeletes];
    let bytes = jsonBytes(this.data);
    for (const row of this.rows.values())
      bytes += row.projectionBytes + (row.storedBody ? row.bodyBytes : 0);
    this.observedAt = Date.now();
    await this.options.persist({
      entry: {
        id: RUN_LIST_COLLECTION_ID,
        data: this.data,
        observedAt: this.observedAt,
        accessedAt: this.observedAt,
        bytes,
      },
      upserts,
      deletes,
    });
    for (const id of deletes) this.unstoredDeletes.delete(id);
  }

  /** A cold start's stored collection; it stays stale until a version reply lists every row. */
  hydrate(stored: StoredResourceRows): boolean {
    if (!stored.entry || this.held) return this.held;
    this.data = stored.entry.data as RunListCollectionData;
    // A version reply carries each summary exactly when it was asked for.
    this.dataFlags = {
      ...(this.data.familySummaries ? { includeFamilySummaries: true } : {}),
      ...(this.data.projectAnalytics ? { includeProjectAnalytics: true } : {}),
    };
    this.observedAt = stored.entry.observedAt;
    for (const row of stored.rows) {
      const projection = row.projection as RunListProjection;
      const projectionBytes = jsonBytes(projection);
      this.rows.set(row.id, {
        version: row.version,
        projection,
        ...(row.body === undefined ? {} : { body: row.body as Run }),
        projectionBytes,
        bodyBytes: row.body === undefined ? 0 : row.bytes - projectionBytes,
        storedBody: row.body !== undefined,
      });
    }
    this.order = stored.rows.map(({ id }) => id);
    return true;
  }

  /** A run.list view: rows and totals from projections; undefined when it needs its own read. */
  view(params: RunListParams): RunListResult | undefined {
    if (!this.data) return undefined;
    const projections = this.order.flatMap((id) => {
      const row = this.rows.get(id);
      return row ? [row.projection] : [];
    });
    const page = runListPage(projections, params);
    const runs = page.runs.flatMap(({ id }) => {
      const body = this.rows.get(id)?.body;
      return body ? [body] : [];
    });
    if (!params.includeFamilySummaries && !params.includeProjectAnalytics)
      return { runs, totalCount: page.totalCount };
    // Summaries read payload values the list trim drops, so only the gateway computes them.
    const flags = runListSummaryFlags(params);
    if (
      page.runs.length < page.totalCount ||
      (params.includeFamilySummaries && !flags.includeFamilySummaries) ||
      (params.includeProjectAnalytics && !flags.includeProjectAnalytics) ||
      (flags.includeFamilySummaries && !this.dataFlags.includeFamilySummaries) ||
      (flags.includeProjectAnalytics && !this.dataFlags.includeProjectAnalytics) ||
      !this.data.summaryMeta
    )
      return undefined;
    return {
      runs,
      totalCount: page.totalCount,
      summaryMeta: this.data.summaryMeta,
      ...(params.includeFamilySummaries ? { familySummaries: this.data.familySummaries } : {}),
      ...(params.includeProjectAnalytics ? { projectAnalytics: this.data.projectAnalytics } : {}),
    };
  }

  /** Every live run's projection, newest first; undefined without a collection. */
  projections(): readonly RunListProjection[] | undefined {
    if (!this.data) return undefined;
    return sortRunList(
      this.order.flatMap((id) => {
        const row = this.rows.get(id);
        return row ? [row.projection] : [];
      }),
      'newest',
    );
  }

  /** Forget everything: a new store, owner or refusal. A running read is abandoned. */
  clear(): void {
    this.inflight?.controller.abort();
    this.inflight = undefined;
    this.order = [];
    this.rows.clear();
    this.unstoredDeletes.clear();
    this.listed = undefined;
    this.data = undefined;
    this.dataFlags = {};
    this.resourceState = undefined;
    this.observedAt = undefined;
  }

  /**
   * The connection changed: abandon a running read, keeping what is held, which counts as current
   * again only after a versions read on the new connection.
   */
  abort(): void {
    this.inflight?.controller.abort();
    this.inflight = undefined;
    this.listed = undefined;
  }
}
