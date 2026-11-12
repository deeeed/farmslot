// The served PR list (ADR-071 Amendment 3). The full read projects its collector's rows on every
// read. Entity reads and pushes serve that same projection, kept per pr.list scope and recomputed
// when its inputs change (a collection, a CI result, runs, slots, workers, configuration);
// versions are stored beside its rows, so a versions or ids read hashes nothing.
import type { PRListResult, PRStatus } from '@farmslot/protocol';
import {
  canonicalResourceJson,
  prEntityId,
  type ResourceKey,
  resourceQuery,
} from '@farmslot/protocol/client-cache';
import { Methods } from '@farmslot/protocol/rpc/registry';

import { entityVersionHash } from '../../resources/entity-version-hash.js';
import { type EntitySnapshot, resourceRevisions } from '../../resources/revisions.js';
import type { PRListFetchResult, PRListProjector } from '../pr.js';

import {
  onPRListCollectorChange,
  peekServedPRList,
  prListHasInterest,
  prListResourceKey,
  type ServedPRList,
} from './list-cache.js';

interface ServedRow {
  pr: PRStatus;
  version: string;
  bytes: number;
}

/** The served list of one scope: rows in served order with their versions, and its fields. */
export interface ServedPRProjection {
  rows: ReadonlyMap<string, ServedRow>;
  meta: Omit<PRListResult, 'prs'>;
}

interface Projection {
  queryId: string;
  project?: string;
  projector: PRListProjector;
  served?: ServedPRProjection;
  /** Order and fields of the last served list; a change moves the membership marker. */
  listing?: string;
  failure?: { error: unknown };
  /** Runs, slots, workers or configuration changed since the last computation. */
  inputsChanged: boolean;
  queued?: Promise<void>;
  running: Promise<void>;
  computedAt: number;
  /** The pending recomputation for changed inputs and when it fires. */
  paced?: { at: number; timer: ReturnType<typeof setTimeout> };
}

const view = resourceQuery(Methods.PR_LIST, {});
/**
 * The local inputs of a served list: every dependency of the pr.list view but its own list key,
 * each with the floor the view rereads it at. A change recomputes no more often than that.
 */
const INPUT_PACE_MS = new Map<ResourceKey['family'], number>(
  view.dependencies
    .filter((key) => key.family !== 'upstream')
    .map((key) => [key.family, view.rereadIntervalMs?.[key.family] ?? 0]),
);

const projections = new Map<string, Projection>();

function upstreamKey(project: string | undefined): ResourceKey & { family: 'upstream' } {
  const key = prListResourceKey(project);
  if (key.family !== 'upstream') throw new Error('pr.list keys are upstream keys');
  return key;
}

/** What pr.list serves for a collector's rows once projected: the scope's rows and its fields. */
export function projectedPRList(
  served: ServedPRList,
  projected: PRListFetchResult,
  project: string | undefined,
): PRListResult {
  const { truncated: _truncated, ...result } = served;
  const incomplete = projected.failed.length > 0 || projected.truncated;
  return {
    ...result,
    prs: projected.prs.filter((row) => project === undefined || row.project === project),
    ...(incomplete
      ? {
          observation: {
            ...result.observation,
            status: 'stale',
            error: result.observation?.error ?? {
              code: 'UPSTREAM_INCOMPLETE',
              message: 'Some current PR identities have no retained upstream observation',
            },
          },
        }
      : {}),
  };
}

async function compute(projection: Projection): Promise<void> {
  const input = peekServedPRList(projection.queryId);
  if (!input) return;
  projection.inputsChanged = false;
  projection.computedAt = Date.now();
  const key = upstreamKey(projection.project);
  let projected: PRListFetchResult;
  try {
    projected = await projection.projector(input.prs, projection.project);
  } catch (error) {
    // Readers rethrow this failure; entity-sync clients learn of it from the marker.
    const first = !projection.failure;
    projection.failure = { error };
    if (first) resourceRevisions.advanceMembership(key);
    return;
  }
  const hadFailure = projection.failure !== undefined;
  projection.failure = undefined;
  const { prs, ...meta } = projectedPRList(input, projected, projection.project);
  const rows = new Map<string, ServedRow>();
  for (const pr of prs)
    rows.set(prEntityId(pr), {
      pr,
      version: entityVersionHash(pr),
      bytes: Buffer.byteLength(JSON.stringify(pr)),
    });
  const previous = projection.served;
  projection.served = { rows, meta };
  for (const [id, row] of rows)
    if (previous?.rows.get(id)?.version !== row.version)
      resourceRevisions.advance({ ...key, prKey: id });
  for (const id of previous?.rows.keys() ?? [])
    if (!rows.has(id)) resourceRevisions.advance({ ...key, prKey: id }, 'deleted');
  // The list key itself advances with its collector, as it always did; here only its marker moves.
  const listing = canonicalResourceJson({ order: [...rows.keys()], meta });
  if (listing !== projection.listing || hadFailure) {
    projection.listing = listing;
    resourceRevisions.advanceMembership(key);
  }
}

/** One computation after any running one; callers asking meanwhile share the queued one. */
function recompute(projection: Projection): Promise<void> {
  if (projection.queued) return projection.queued;
  const queued = projection.running.then(() => {
    if (projection.queued === queued) projection.queued = undefined;
    return compute(projection);
  });
  projection.queued = queued;
  projection.running = queued;
  return queued;
}

function projectionFor(project: string | undefined, projector: PRListProjector): Projection {
  const queryId = upstreamKey(project).queryId;
  let projection = projections.get(queryId);
  if (!projection) {
    projection = {
      queryId,
      ...(project === undefined ? {} : { project }),
      projector,
      inputsChanged: false,
      running: Promise.resolve(),
      computedAt: 0,
    };
    projections.set(queryId, projection);
  }
  projection.projector = projector;
  return projection;
}

/** The maintained served list of a scope whose collector holds a snapshot. */
export async function servedPRList(
  project: string | undefined,
  projector: PRListProjector,
): Promise<ServedPRProjection> {
  const projection = projectionFor(project, projector);
  if (!projection.served || projection.failure || (projection.inputsChanged && !projection.paced))
    await recompute(projection);
  if (projection.failure) throw projection.failure.error;
  if (!projection.served) throw new Error('The PR list collector holds no snapshot');
  return projection.served;
}

/** The served PR behind a per-PR key, for publication. */
function prEntityProvider(key: ResourceKey): EntitySnapshot | undefined {
  if (key.family !== 'upstream' || !('prKey' in key)) return undefined;
  const row = projections.get(key.queryId)?.served?.rows.get(key.prKey);
  return row
    ? { family: 'upstream', entity: row.pr, version: row.version, bytes: row.bytes }
    : undefined;
}
resourceRevisions.setEntityProvider('upstream', prEntityProvider);

// A collector change recomputes the served list of a scope some entity read has asked for.
onPRListCollectorChange((queryId) => {
  const projection = projections.get(queryId);
  if (projection?.served) void recompute(projection);
});

resourceRevisions.registerEntityCollection(
  (key) =>
    key.family === 'upstream' &&
    key.integration === 'github' &&
    !('prKey' in key) &&
    key.queryId.startsWith(`${Methods.PR_LIST}:`),
);

function inputsChanged(paceMs: number): void {
  for (const projection of projections.values()) {
    projection.inputsChanged = true;
    if (!projection.served || !prListHasInterest(projection.queryId)) continue;
    const at = Math.max(Date.now(), projection.computedAt + paceMs);
    if (projection.paced && projection.paced.at <= at) continue;
    if (projection.paced) clearTimeout(projection.paced.timer);
    const timer = setTimeout(() => {
      projection.paced = undefined;
      void recompute(projection);
    }, at - Date.now());
    timer.unref();
    projection.paced = { at, timer };
  }
}

/** Recomputes observed scopes when their local inputs change. Returns its teardown. */
export function startServedPRListMaintenance(revisions = resourceRevisions): () => void {
  const stop = revisions.subscribe((payload) => {
    const paces = payload.changes.flatMap((change) => INPUT_PACE_MS.get(change.key.family) ?? []);
    if (paces.length) inputsChanged(Math.min(...paces));
  });
  return () => {
    stop();
    for (const projection of projections.values()) {
      if (projection.paced) clearTimeout(projection.paced.timer);
      projection.paced = undefined;
    }
  };
}

export function resetServedPRListsForTests(): void {
  for (const projection of projections.values())
    if (projection.paced) clearTimeout(projection.paced.timer);
  projections.clear();
}
