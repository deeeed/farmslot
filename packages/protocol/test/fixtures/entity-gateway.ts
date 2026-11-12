// A scripted gateway for entity-sync cache tests: it answers fleet.status and pr.list in every
// read shape from its own state, numbers revisions like the real one, and logs each request.
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import {
  canonicalResourceJson,
  type ResourceCacheConnection,
  type ResourceCacheTransport,
  type ResourceKey,
  resourceKeyId,
  resourceQuery,
  type ResourceReadMethod,
  type ResourceReadResult,
} from '../../src/client-cache/index.js';
import type { PRStatus } from '../../src/contracts/reviews.js';
import type { MachineHealth, SlotEntity } from '../../src/contracts/slots.js';
import { computeSummary } from '../../src/fleet/summary.js';
import type { UpstreamObservation } from '../../src/rpc/resource-observers.js';
import type {
  ChangedEntity,
  ResourceChangedPayload,
  ResourceChangeEntry,
} from '../../src/transport/events.js';

const encoder = new TextEncoder();

/** The gateway's entity version: sha256 of the body's canonical JSON. */
export function versionOf(entity: unknown): string {
  return bytesToHex(sha256(encoder.encode(canonicalResourceJson(entity))));
}

export function slot(id: string, patch: Partial<SlotEntity> = {}): SlotEntity {
  return {
    slot: id,
    machine: 'mac-a',
    platform: 'macos',
    project: 'demo',
    health: { ssh: 'OK', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: false,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
    ...patch,
  };
}

export function machine(name: string, cpuPercent = 10): MachineHealth {
  return {
    machine: name,
    online: true,
    headroom: 'green',
    system: {
      cpuPercent,
      memoryPercent: 20,
      memoryUsedGb: 4,
      memoryTotalGb: 16,
      diskPercent: 30,
      loadAvg1: 1,
      loadAvg5: 1,
    },
  };
}

export function pr(repo: string, n: number, patch: Partial<PRStatus> = {}): PRStatus {
  return {
    pr: n,
    title: `PR ${n}`,
    summary: null,
    repo,
    headRef: `feat/${n}`,
    project: 'demo',
    slot: null,
    session: null,
    checks: [],
    checkSummary: { passed: 0, failed: 0, pending: 1, skipped: 0, total: 1 },
    allPassed: false,
    anyFailed: false,
    failedNames: [],
    botComments: [],
    actionableBotComments: [],
    prState: 'OPEN',
    merged: false,
    mergeable: 'MERGEABLE',
    mergeConflict: false,
    reviewDecision: '',
    recommendation: 'WORKING',
    ...patch,
  };
}

export const prId = (row: PRStatus) => `${row.repo}/${row.pr}`;

interface Logged {
  method: string;
  params: Record<string, unknown>;
}

interface Hold {
  match(entry: Logged): boolean;
  arrived: Promise<void>;
  arrive(): void;
  release?: () => void;
  released: Promise<void>;
  open(): void;
}

export interface EntityGatewayOptions {
  entitySync?: boolean;
  epoch?: string;
}

const SLOTS_KEY: ResourceKey = { family: 'slots', scope: 'farm' };

/** A scripted gateway. Replies are computed when a request arrives and may be held back. */
export class EntityGateway implements ResourceCacheTransport {
  connection: ResourceCacheConnection;
  readonly slots = new Map<string, SlotEntity>();
  readonly machines = new Map<string, MachineHealth>();
  /** PR rows per project scope; '' is the farm scope. */
  readonly prs = new Map<string, Map<string, PRStatus>>();
  prMeta: { observation?: UpstreamObservation; fetchedAt?: string; refreshing?: boolean } = {
    observation: { status: 'ready', observedAt: 1_000 },
    fetchedAt: '2026-11-12T00:00:00.000Z',
  };
  checkedAt = '2026-11-12T00:00:00.000Z';
  readonly log: Logged[] = [];
  readonly observers: unknown[] = [];
  /** Requests and observer acknowledgements in arrival order. */
  readonly timeline: string[] = [];
  /** Versions this gateway lists in place of an entity's real one (a lying or corrupt source). */
  readonly listedVersions = new Map<string, string>();
  /** Requests beyond this are refused, so a read loop fails a test instead of hanging it. */
  requestCap = 30;
  /** While set, every fleet.status read is refused with it, as a failed fleet source refuses them. */
  fleetRefusal?: { code: string; message: string };
  private readonly revisions = new Map<string, number>();
  private readonly markers = new Map<string, number>();
  private readonly holds: Hold[] = [];
  private readonly connections = new Set<(connection: ResourceCacheConnection) => void>();
  private readonly listeners = new Set<(payload: ResourceChangedPayload) => void>();

  constructor(options: EntityGatewayOptions = {}) {
    this.connection = {
      id: 1,
      connected: true,
      authMode: 'token',
      scope: { gatewayUrl: 'ws://entity.test/', principalId: 'operator', principalGeneration: 0 },
      authority: { roles: [], workspaceAccess: 'farm' },
      capabilities: {
        httpBearerAuth: true,
        voiceInstructionFormatting: false,
        resourceChanges: {
          version: 1,
          epoch: options.epoch ?? 'epoch-1',
          versionLists: false,
          observedReads: 1,
          upstreamObservers: { version: 1, methods: ['pr.list'] },
          ...(options.entitySync === false ? {} : { entitySync: true }),
        },
      },
    };
  }

  get epoch(): string {
    return this.connection.capabilities?.resourceChanges?.epoch ?? '';
  }

  getConnection = (): ResourceCacheConnection => this.connection;
  onConnectionChange = (listener: (connection: ResourceCacheConnection) => void) => {
    this.connections.add(listener);
    return () => {
      this.connections.delete(listener);
    };
  };
  onResourceChanged = (listener: (payload: ResourceChangedPayload) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  resynchronize = (): void => this.setConnection({ connected: false });

  setConnection(change: Partial<ResourceCacheConnection>): void {
    this.connection = { ...this.connection, ...change };
    for (const listener of this.connections) listener(this.connection);
  }

  /**
   * A new socket on a restarted gateway: revisions and markers start over. `entitySync` set says
   * whether the restarted gateway advertises entity sync.
   */
  reconnect(epoch = this.epoch, entitySync?: boolean): void {
    if (epoch !== this.epoch) {
      this.revisions.clear();
      this.markers.clear();
    }
    const resourceChanges = this.connection.capabilities?.resourceChanges;
    this.setConnection({
      id: Number(this.connection.id) + 1,
      connected: true,
      capabilities: {
        httpBearerAuth: true,
        voiceInstructionFormatting: false,
        ...this.connection.capabilities,
        ...(resourceChanges
          ? {
              resourceChanges: {
                ...resourceChanges,
                epoch,
                ...(entitySync === undefined ? {} : { entitySync }),
              },
            }
          : {}),
      },
    });
  }

  replaceObservers = async (params: { version: 1; sequence: number; queries: unknown[] }) => {
    this.observers.push(params.queries);
    // The acknowledgement crosses the socket after any read already sent.
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.timeline.push('observers-applied');
    return { version: 1 as const, sequence: params.sequence, applied: true };
  };

  /** Holds the reply to the next matching request until `release()`; the reply is computed on arrival. */
  hold(match: (entry: Logged) => boolean): {
    arrived: Promise<void>;
    release: () => void;
  } {
    let arrive!: () => void;
    let open!: () => void;
    const hold: Hold = {
      match,
      arrived: new Promise((resolve) => (arrive = resolve)),
      arrive: () => arrive(),
      released: new Promise((resolve) => (open = resolve)),
      open: () => open(),
    };
    this.holds.push(hold);
    return { arrived: hold.arrived, release: () => hold.open() };
  }

  requests(method: string, shape?: 'versions' | 'ids' | 'full'): Logged[] {
    return this.log.filter(
      (entry) =>
        entry.method === method &&
        (shape === undefined ||
          (shape === 'versions'
            ? entry.params.versions === true
            : shape === 'ids'
              ? Array.isArray(entry.params.ids)
              : entry.params.versions === undefined && entry.params.ids === undefined)),
    );
  }

  request<T>(method: ResourceReadMethod, params: unknown): Promise<ResourceReadResult<T>> {
    const record: Record<string, unknown> =
      params && typeof params === 'object' ? { ...params } : {};
    const entry = { method, params: record };
    this.log.push(entry);
    this.timeline.push(
      `${method} ${record.versions === true ? 'versions' : Array.isArray(record.ids) ? 'ids' : 'full'}`,
    );
    if (this.log.length > this.requestCap)
      return Promise.reject(
        Object.assign(new Error('request cap reached'), { code: 'TEST_REQUEST_CAP' }),
      );
    let reply: ResourceReadResult<T>;
    try {
      if (method === 'fleet.status' && this.fleetRefusal)
        throw Object.assign(new Error(this.fleetRefusal.message), {
          code: this.fleetRefusal.code,
        });
      reply = this.answer<T>(method, record);
    } catch (error) {
      return Promise.reject(error);
    }
    const index = this.holds.findIndex((hold) => hold.match(entry));
    if (index < 0) return Promise.resolve(reply);
    const [hold] = this.holds.splice(index, 1);
    hold.arrive();
    return hold.released.then(() => reply);
  }

  private stamp(method: ResourceReadMethod, params: Record<string, unknown>) {
    const { versions: _versions, ids: _ids, ...view } = params;
    const dependencies = resourceQuery(method, view).dependencies;
    return {
      epoch: this.epoch,
      dependencies: dependencies.map((key) => ({ key, revision: this.revision(key) })),
    };
  }

  private answer<T>(method: ResourceReadMethod, params: Record<string, unknown>) {
    const resourceState = this.stamp(method, params);
    const data = method === 'fleet.status' ? this.fleet(params) : this.prList(params);
    // The fixture's replies are JSON values shaped by the method under test.
    return { data: JSON.parse(JSON.stringify(data)) as T, resourceState };
  }

  private fleet(params: Record<string, unknown>) {
    const slots = [...this.slots.values()];
    const machines = [...this.machines.values()];
    if (params.versions === true)
      return {
        versions: slots.map((row) => ({
          id: row.slot,
          version: this.listedVersions.get(row.slot) ?? versionOf(row),
        })),
        summary: computeSummary(slots),
        ...(machines.length ? { machines } : {}),
        checkedAt: this.checkedAt,
        membershipRevision: this.marker(SLOTS_KEY),
      };
    if (Array.isArray(params.ids)) {
      const entities = params.ids.flatMap((id) => {
        const row = typeof id === 'string' ? this.slots.get(id) : undefined;
        return row ? [row] : [];
      });
      return {
        entities,
        versions: entities.map((row) => ({ id: row.slot, version: versionOf(row) })),
      };
    }
    return {
      fleet: {
        checkedAt: this.checkedAt,
        slots,
        summary: computeSummary(slots),
        ...(machines.length ? { machines } : {}),
      },
    };
  }

  prKey(project?: string): ResourceKey {
    return resourceQuery('pr.list', project === undefined ? {} : { project }).dependencies[0];
  }

  private prRows(project?: string): Map<string, PRStatus> {
    const scope = project ?? '';
    let rows = this.prs.get(scope);
    if (!rows) {
      rows = new Map();
      this.prs.set(scope, rows);
    }
    return rows;
  }

  private prList(params: Record<string, unknown>) {
    const project = typeof params.project === 'string' ? params.project : undefined;
    const rows = [...this.prRows(project).values()];
    if (params.versions === true)
      return {
        versions: rows.map((row) => ({ id: prId(row), version: versionOf(row) })),
        ...this.prMeta,
        membershipRevision: this.marker(this.prKey(project)),
      };
    if (Array.isArray(params.ids)) {
      const byId = new Map(rows.map((row) => [prId(row), row]));
      const entities = params.ids.flatMap((id) => {
        const row = typeof id === 'string' ? byId.get(id) : undefined;
        return row ? [row] : [];
      });
      return {
        entities,
        versions: entities.map((row) => ({ id: prId(row), version: versionOf(row) })),
      };
    }
    return { prs: rows, ...this.prMeta };
  }

  revision(key: ResourceKey): number {
    return this.revisions.get(resourceKeyId(key)) ?? 0;
  }

  marker(key: ResourceKey): number {
    return this.markers.get(resourceKeyId(key)) ?? 0;
  }

  /** Publishes one notification: each key advances; a collection key carries its marker. */
  publish(
    changes: Array<{
      key: ResourceKey;
      kind?: 'updated' | 'deleted';
      changedEntity?: ChangedEntity;
      membership?: boolean;
    }>,
  ): void {
    const entries: ResourceChangeEntry[] = changes.map((change) => {
      const id = resourceKeyId(change.key);
      const revision = (this.revisions.get(id) ?? 0) + 1;
      this.revisions.set(id, revision);
      if (change.membership) this.markers.set(id, (this.markers.get(id) ?? 0) + 1);
      const collection =
        change.key.family === 'slots' ||
        (change.key.family === 'upstream' && !('prKey' in change.key));
      const marker = this.markers.get(id);
      return {
        key: change.key,
        revision,
        kind: change.kind ?? 'updated',
        ...(change.changedEntity ? { changedEntity: change.changedEntity } : {}),
        ...(collection ? { membershipRevision: marker ?? 0 } : {}),
      };
    });
    const payload: ResourceChangedPayload = { version: 1, epoch: this.epoch, changes: entries };
    for (const listener of this.listeners) listener(payload);
  }

  /** A slot write: the slot key carries the body (or not), the collection key keeps its marker. */
  writeSlot(row: SlotEntity, attach: 'entity' | 'none' | 'version' = 'entity'): void {
    const added = !this.slots.has(row.slot);
    this.slots.set(row.slot, row);
    this.publish([
      {
        key: { family: 'slot', slotId: row.slot },
        ...(attach === 'none'
          ? {}
          : {
              changedEntity:
                attach === 'entity'
                  ? { family: 'slot', entity: row, version: versionOf(row) }
                  : { family: 'slot', version: versionOf(row) },
            }),
      },
      { key: SLOTS_KEY, membership: added },
    ]);
  }

  /**
   * A fleet source invalidated a slot without changing it: the slot is named by its version, and
   * the fleet marker moves only when the source settled to another outcome.
   */
  invalidateSlot(id: string, outcomeChanged: boolean): void {
    const row = this.slots.get(id);
    if (!row) throw new Error(`no slot ${id}`);
    this.publish([
      {
        key: { family: 'slot', slotId: id },
        changedEntity: { family: 'slot', version: versionOf(row) },
      },
      { key: SLOTS_KEY, membership: outcomeChanged },
    ]);
  }

  deleteSlot(id: string): void {
    this.slots.delete(id);
    this.publish([
      { key: { family: 'slot', slotId: id }, kind: 'deleted' },
      { key: SLOTS_KEY, membership: true },
    ]);
  }

  writeMachine(row: MachineHealth): void {
    this.machines.set(row.machine, row);
    this.publish([
      {
        key: { family: 'node', nodeId: row.machine },
        changedEntity: { family: 'node', entity: row, version: versionOf(row) },
      },
      { key: SLOTS_KEY },
    ]);
  }

  writePR(row: PRStatus, project?: string, attach: 'entity' | 'none' = 'entity'): void {
    const rows = this.prRows(project);
    const added = !rows.has(prId(row));
    rows.set(prId(row), row);
    const collection = this.prKey(project);
    if (collection.family !== 'upstream') throw new Error('PR list key must be upstream');
    this.publish([
      {
        key: { ...collection, prKey: prId(row) },
        ...(attach === 'entity'
          ? { changedEntity: { family: 'upstream', entity: row, version: versionOf(row) } }
          : {}),
      },
      { key: collection, membership: added },
    ]);
  }

  /** A collection's non-entity fields changed: only the marker tells an entity-sync client. */
  writePRMeta(meta: EntityGateway['prMeta'], project?: string): void {
    this.prMeta = meta;
    this.publish([{ key: this.prKey(project), membership: true }]);
  }
}

/** Lets queued microtasks, store writes and immediate timers run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
