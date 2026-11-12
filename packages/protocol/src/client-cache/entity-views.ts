// Entity sync views (ADR-071 Amendment 3): fleet.status and pr.list views answered from an
// entity collection plus the collection's non-entity fields, kept current by notifications.
import type { PRStatus } from '../contracts/reviews.js';
import type {
  FleetPoolReadError,
  FleetSummary,
  MachineHealth,
  SlotEntity,
} from '../contracts/slots.js';
import { reattachHostLoad } from '../fleet/host-load.js';
import { computeSummary } from '../fleet/summary.js';
import type { FleetStatusResult } from '../rpc/fleet.js';
import type { PRListResult } from '../rpc/pr.js';
import { Methods } from '../rpc/registry.js';
import type { UpstreamObservation } from '../rpc/resource-observers.js';
import type { ResourceChangeEntry } from '../transport/events.js';

import {
  EntityCollection,
  type EntitySyncPage,
  type EntityVersionEntry,
} from './entity-collection.js';
import {
  admitEntity,
  entityContentVersion,
  isMachineHealthEntity,
  isPRStatusEntity,
  isSlotEntity,
  prEntityId,
} from './entity-guards.js';
import { canonicalResourceJson, type ResourceKey, resourceKeyId } from './keys.js';
import type { ResourceQuery } from './registry.js';
import type { StoredResourceRows } from './store.js';

/** Reads the cache sends for a view; the reply data is untrusted JSON. */
export type EntityViewRequest = (params: unknown, signal: AbortSignal) => Promise<unknown>;

/** The view's answer from what the collection holds. */
export interface EntityViewAnswer {
  data: unknown;
  /** Verified on this connection with nothing notified left unread. */
  current: boolean;
}

/** What the cache needs from any entity view, independent of its entity type. */
export interface EntityView {
  readonly storeId: string;
  /** The id of the collection key this view applies itself; its other dependencies are read. */
  readonly collectionKeyId: string;
  /** Rows were hydrated from this store, if any. */
  hydratedFrom?: object;
  serves(query: ResourceQuery): boolean;
  /** Applies a notification; true when it concerns this view. */
  applyChange(change: ResourceChangeEntry): boolean;
  sync(
    request: EntityViewRequest,
    onPage?: (done: number, total: number) => void,
  ): Promise<boolean>;
  answer(): EntityViewAnswer | undefined;
  hydrate(stored: StoredResourceRows): void;
  /** The view holds rows or a listing. */
  readonly held: boolean;
  /** Rows a full read already put on screen, when the view holds none of its own. */
  seed(full: unknown): void;
  /** Something this view cannot apply changed what the gateway serves: read the listing again. */
  requireVersions(): void;
  /** Rows changed since the last call and the collection data, for one store merge. */
  takeUnstored(): {
    data: unknown;
    metaChanged: boolean;
    upserts: Array<{ id: string; version: string; body: unknown; bytes: number }>;
    deletes: string[];
    /** UTF-8 JSON bytes of the whole stored collection after this merge. */
    bytes: number;
  };
  unverify(): void;
  clear(): void;
}

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function versionsOf(
  data: unknown,
): { versions: EntityVersionEntry[]; marker?: number } | undefined {
  if (!isRecord(data) || !Array.isArray(data.versions)) return undefined;
  const versions = data.versions.filter(
    (entry): entry is EntityVersionEntry =>
      isRecord(entry) && typeof entry.id === 'string' && typeof entry.version === 'string',
  );
  const marker = data.membershipRevision;
  return {
    versions,
    ...(typeof marker === 'number' && Number.isSafeInteger(marker) ? { marker } : {}),
  };
}

function pageOf(data: unknown): EntitySyncPage<unknown> {
  if (!isRecord(data)) return { entities: [], versions: [] };
  return {
    entities: Array.isArray(data.entities) ? data.entities : [],
    versions: Array.isArray(data.versions)
      ? data.versions.filter(
          (entry): entry is EntityVersionEntry =>
            isRecord(entry) && typeof entry.id === 'string' && typeof entry.version === 'string',
        )
      : [],
  };
}

function invalidReply(method: string): Error {
  return Object.assign(new Error(`The gateway sent an invalid ${method} versions reply.`), {
    code: 'RESOURCE_STATE_MISSING',
  });
}

interface ViewSpec<T, M> {
  method: typeof Methods.FLEET_STATUS | typeof Methods.PR_LIST;
  storeId: string;
  viewParams: Record<string, unknown>;
  collectionKey: ResourceKey;
  family: 'slot' | 'upstream';
  /** This view's entity id for a per-entity key, else undefined. */
  entityId(key: ResourceKey): string | undefined;
  idOf(entity: T): string;
  guard(value: unknown): value is T;
  readMeta(data: Record<string, unknown>): M | undefined;
  isMeta(value: unknown): value is M;
  /**
   * A notification other than the collection's own that changes one of its non-entity fields:
   * the field's id and how it changes them, or `reread` when only a versions read can tell.
   */
  applyOther?(
    change: ResourceChangeEntry,
    meta: M | undefined,
  ): { id: string; patch?: (meta: M) => M; reread?: boolean } | undefined;
  /** The rows and non-entity fields of a full read's reply, both untrusted. */
  fromFull(data: Record<string, unknown>): { rows: SeedRow[]; meta: unknown } | undefined;
  answer(rows: T[], meta: M, current: boolean): unknown;
}

interface SeedRow {
  id: string;
  body: unknown;
}

class SpecView<T, M> implements EntityView {
  hydratedFrom?: object;
  private meta?: M;
  private metaUnstored = false;
  /** Stored bytes per row, for the collection entry's size. */
  private readonly rowBytes = new Map<string, number>();
  /** Non-entity changes notified since the outstanding versions request was sent, by field id. */
  private readonly metaPatches = new Map<string, { at: number; patch: (meta: M) => M }>();
  private metaSequence = 0;
  private request?: EntityViewRequest;
  private onPage?: (done: number, total: number) => void;
  readonly collectionKeyId: string;
  readonly collection: EntityCollection<T>;

  constructor(private readonly spec: ViewSpec<T, M>) {
    this.collectionKeyId = resourceKeyId(spec.collectionKey);
    this.collection = new EntityCollection<T>({
      idOf: spec.idOf,
      accept: (value, id, version): value is T =>
        admitEntity(spec.guard, spec.idOf, value, id, version),
      fetchVersions: async (signal) => {
        const sent = this.metaSequence;
        const data = await this.send({ ...spec.viewParams, versions: true }, signal);
        const listing = versionsOf(data);
        const meta = isRecord(data) ? spec.readMeta(data) : undefined;
        if (!listing || meta === undefined) throw invalidReply(spec.method);
        if (!signal.aborted) {
          // A change notified after the request was sent is newer than the reply's field.
          let merged: M = meta;
          for (const [id, change] of this.metaPatches)
            if (change.at > sent) merged = change.patch(merged);
            else this.metaPatches.delete(id);
          this.meta = merged;
          this.metaUnstored = true;
        }
        return {
          versions: listing.versions,
          ...(listing.marker === undefined ? {} : { membershipRevision: listing.marker }),
        };
      },
      fetchPage: async (ids, signal) =>
        pageOf(await this.send({ ...spec.viewParams, ids }, signal)),
      onPage: (done, total) => this.onPage?.(done, total),
    });
  }

  get storeId(): string {
    return this.spec.storeId;
  }

  private send(params: unknown, signal: AbortSignal): Promise<unknown> {
    if (!this.request) throw new Error('Entity view read outside a sync');
    return this.request(params, signal);
  }

  serves(query: ResourceQuery): boolean {
    return (
      query.method === this.spec.method &&
      canonicalResourceJson(query.params) === canonicalResourceJson(this.spec.viewParams)
    );
  }

  applyChange(change: ResourceChangeEntry): boolean {
    if (resourceKeyId(change.key) === this.collectionKeyId) {
      this.collection.noteMembership(change.membershipRevision);
      return true;
    }
    const id = this.spec.entityId(change.key);
    if (id !== undefined) {
      const pushed = change.changedEntity;
      if (change.kind === 'deleted') this.collection.applyDeleted(id);
      else if (!pushed || pushed.family !== this.spec.family || typeof pushed.version !== 'string')
        this.collection.applyUnknown(id);
      else if (pushed.entity === undefined) this.collection.applyVersion(id, pushed.version);
      else this.collection.applyEntity(id, pushed.entity, pushed.version);
      return true;
    }
    const other = this.spec.applyOther?.(change, this.meta);
    if (!other) return false;
    if (other.patch) {
      this.metaPatches.set(other.id, { at: ++this.metaSequence, patch: other.patch });
      if (this.meta !== undefined) {
        this.meta = other.patch(this.meta);
        this.metaUnstored = true;
      }
    }
    // Only a versions read carries these fields; the marker cannot say so.
    if (other.reread) this.requireVersions();
    return true;
  }

  requireVersions(): void {
    this.collection.noteMembership(undefined);
  }

  async sync(
    request: EntityViewRequest,
    onPage?: (done: number, total: number) => void,
  ): Promise<boolean> {
    this.request = request;
    this.onPage = onPage;
    try {
      return await this.collection.sync();
    } finally {
      if (this.request === request) this.request = undefined;
      if (this.onPage === onPage) this.onPage = undefined;
    }
  }

  answer(): EntityViewAnswer | undefined {
    const rows = this.collection.assemble();
    if (!rows || this.meta === undefined) return undefined;
    const current = this.collection.current;
    return { data: this.spec.answer(rows, this.meta, current), current };
  }

  hydrate(stored: StoredResourceRows): void {
    this.collection.hydrate(stored.rows);
    for (const row of stored.rows) this.rowBytes.set(row.id, row.bytes);
    const data = stored.entry?.data;
    if (this.meta === undefined && this.spec.isMeta(data)) this.meta = data;
  }

  get held(): boolean {
    return this.collection.held;
  }

  seed(full: unknown): void {
    if (this.held || !isRecord(full)) return;
    const seeded = this.spec.fromFull(full);
    if (!seeded) return;
    // Admitted like any stored row, at the version of the body itself: the listing decides.
    this.collection.hydrate(
      seeded.rows.map(({ id, body }) => ({ id, version: entityContentVersion(body), body })),
    );
    if (this.meta === undefined && this.spec.isMeta(seeded.meta)) this.meta = seeded.meta;
  }

  takeUnstored() {
    const { upserts, deletes } = this.collection.takeUnstored();
    const metaChanged = this.metaUnstored;
    this.metaUnstored = false;
    const stored = upserts.map(({ id, version, entity }) => {
      const bytes = encoder.encode(JSON.stringify(entity)).byteLength;
      this.rowBytes.set(id, bytes);
      return { id, version, body: entity, bytes };
    });
    for (const id of deletes) this.rowBytes.delete(id);
    let bytes = encoder.encode(JSON.stringify(this.meta ?? null)).byteLength;
    for (const size of this.rowBytes.values()) bytes += size;
    return { data: this.meta, metaChanged, upserts: stored, deletes, bytes };
  }

  unverify(): void {
    this.collection.unverify();
  }

  clear(): void {
    this.collection.clear();
    this.meta = undefined;
    this.metaUnstored = false;
    this.metaPatches.clear();
    this.rowBytes.clear();
    this.hydratedFrom = undefined;
  }
}

// ─── fleet.status ───

interface FleetMeta {
  summary: FleetSummary;
  machines?: MachineHealth[];
  checkedAt: string;
  poolErrors?: FleetPoolReadError[];
}

const SUMMARY_FIELDS = [
  'total',
  'ready',
  'busy',
  'held',
  'manual',
  'disabled',
  'blocked',
  'warmCount',
];

function isFleetSummary(value: unknown): value is FleetSummary {
  return isRecord(value) && SUMMARY_FIELDS.every((field) => typeof value[field] === 'number');
}

function isFleetMeta(value: unknown): value is FleetMeta {
  return (
    isRecord(value) &&
    typeof value.checkedAt === 'string' &&
    isFleetSummary(value.summary) &&
    (value.machines === undefined ||
      (Array.isArray(value.machines) && value.machines.every(isMachineHealthEntity))) &&
    (value.poolErrors === undefined || Array.isArray(value.poolErrors))
  );
}

/** The farm fleet's stored rows; one collection answers the one fleet.status view. */
export const FLEET_ENTITY_STORE_ID = `${Methods.FLEET_STATUS}:{"versions":true}`;

export function createFleetEntityView(): EntityView {
  return new SpecView<SlotEntity, FleetMeta>({
    method: Methods.FLEET_STATUS,
    storeId: FLEET_ENTITY_STORE_ID,
    viewParams: {},
    collectionKey: { family: 'slots', scope: 'farm' },
    family: 'slot',
    entityId: (key) => (key.family === 'slot' ? key.slotId : undefined),
    idOf: (entity) => entity.slot,
    guard: isSlotEntity,
    readMeta: (data) => {
      const meta = {
        summary: data.summary,
        checkedAt: data.checkedAt,
        ...(data.machines === undefined ? {} : { machines: data.machines }),
        ...(data.poolErrors === undefined ? {} : { poolErrors: data.poolErrors }),
      };
      return isFleetMeta(meta) ? meta : undefined;
    },
    isMeta: isFleetMeta,
    applyOther: (change, meta) => {
      if (change.key.family !== 'node' || !('nodeId' in change.key)) return undefined;
      const id = change.key.nodeId;
      const pushed = change.changedEntity;
      if (change.kind === 'deleted')
        return {
          id,
          patch: (held) => ({
            ...held,
            machines: (held.machines ?? []).filter((row) => row.machine !== id),
          }),
        };
      if (pushed?.family !== 'node' || typeof pushed.version !== 'string')
        return { id, reread: true };
      if (pushed.entity === undefined) {
        const held = meta?.machines?.find((row) => row.machine === id);
        return held && entityContentVersion(held) === pushed.version
          ? undefined
          : { id, reread: true };
      }
      if (
        !admitEntity(isMachineHealthEntity, (row) => row.machine, pushed.entity, id, pushed.version)
      )
        return { id, reread: true };
      const entity = pushed.entity;
      return {
        id,
        patch: (held) => {
          const machines = held.machines ?? [];
          return {
            ...held,
            machines: machines.some((row) => row.machine === id)
              ? machines.map((row) => (row.machine === id ? entity : row))
              : [...machines, entity],
          };
        },
      };
    },
    fromFull: (data) => {
      const fleet = data.fleet;
      if (!isRecord(fleet) || !Array.isArray(fleet.slots)) return undefined;
      return {
        rows: fleet.slots.flatMap((row): SeedRow[] => {
          if (!isRecord(row) || typeof row.slot !== 'string') return [];
          // Host load is the machine's; a slot entity never carries it.
          const { hostLoad: _hostLoad, ...body } = row;
          return [{ id: row.slot, body }];
        }),
        meta: {
          summary: fleet.summary,
          checkedAt: fleet.checkedAt,
          ...(fleet.machines === undefined ? {} : { machines: fleet.machines }),
          ...(fleet.poolErrors === undefined ? {} : { poolErrors: fleet.poolErrors }),
        },
      };
    },
    answer: (rows, meta, current): FleetStatusResult => {
      const slots = reattachHostLoad(rows, meta.machines);
      return {
        fleet: {
          checkedAt: meta.checkedAt,
          slots,
          // A partial collection keeps the gateway's own counts until every row is held.
          summary: current ? computeSummary(slots) : meta.summary,
          ...(meta.machines ? { machines: meta.machines } : {}),
          ...(meta.poolErrors ? { poolErrors: meta.poolErrors } : {}),
        },
      };
    },
  });
}

// ─── pr.list ───

interface PRMeta {
  observation?: UpstreamObservation;
  fetchedAt?: string;
  refreshing?: boolean;
}

function isObservation(value: unknown): value is UpstreamObservation {
  return (
    isRecord(value) &&
    (value.status === 'ready' || value.status === 'stale' || value.status === 'error') &&
    (value.observedAt === undefined || typeof value.observedAt === 'number') &&
    (value.error === undefined ||
      (isRecord(value.error) &&
        typeof value.error.code === 'string' &&
        typeof value.error.message === 'string'))
  );
}

function isPRMeta(value: unknown): value is PRMeta {
  return (
    isRecord(value) &&
    (value.observation === undefined || isObservation(value.observation)) &&
    (value.fetchedAt === undefined || typeof value.fetchedAt === 'string') &&
    (value.refreshing === undefined || typeof value.refreshing === 'boolean')
  );
}

/** Store ids that hold entity rows rather than a view's reply. */
export function isEntityStoreId(id: string): boolean {
  return (
    id === FLEET_ENTITY_STORE_ID ||
    (id.startsWith(`${Methods.PR_LIST}:`) && id.endsWith('"versions":true}'))
  );
}

/** The stored rows of one pr.list scope. */
export function prEntityStoreId(project: string | undefined): string {
  return `${Methods.PR_LIST}:${canonicalResourceJson({ ...(project === undefined ? {} : { project }), versions: true })}`;
}

/** The pr.list scope of a view query, or undefined when the query is not a pr.list view. */
export function prViewProject(query: ResourceQuery): { project?: string } | undefined {
  if (query.method !== Methods.PR_LIST) return undefined;
  const project =
    query.params && typeof query.params === 'object'
      ? Reflect.get(query.params, 'project')
      : undefined;
  return typeof project === 'string' ? { project } : {};
}

/** One pr.list scope; `collectionKey` is the view query's upstream key. */
export function createPREntityView(
  project: string | undefined,
  collectionKey: ResourceKey,
): EntityView {
  const queryId = collectionKey.family === 'upstream' ? collectionKey.queryId : '';
  return new SpecView<PRStatus, PRMeta>({
    method: Methods.PR_LIST,
    storeId: prEntityStoreId(project),
    viewParams: project === undefined ? {} : { project },
    collectionKey,
    family: 'upstream',
    entityId: (key) =>
      key.family === 'upstream' && 'prKey' in key && key.queryId === queryId
        ? key.prKey
        : undefined,
    idOf: prEntityId,
    guard: isPRStatusEntity,
    readMeta: (data) => {
      const meta = {
        ...(data.observation === undefined ? {} : { observation: data.observation }),
        ...(data.fetchedAt === undefined ? {} : { fetchedAt: data.fetchedAt }),
        ...(data.refreshing === undefined ? {} : { refreshing: data.refreshing }),
      };
      return isPRMeta(meta) ? meta : undefined;
    },
    isMeta: isPRMeta,
    fromFull: (data) => {
      if (!Array.isArray(data.prs)) return undefined;
      return {
        rows: data.prs.flatMap((row): SeedRow[] =>
          isRecord(row) && typeof row.repo === 'string' && typeof row.pr === 'number'
            ? [{ id: `${row.repo}/${row.pr}`, body: row }]
            : [],
        ),
        meta: {
          ...(data.observation === undefined ? {} : { observation: data.observation }),
          ...(data.fetchedAt === undefined ? {} : { fetchedAt: data.fetchedAt }),
          ...(data.refreshing === undefined ? {} : { refreshing: data.refreshing }),
        },
      };
    },
    answer: (rows, meta): PRListResult => ({ prs: rows, ...meta }),
  });
}
