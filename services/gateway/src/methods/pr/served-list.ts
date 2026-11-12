// The served PR list (ADR-071 Amendment 4). The full read projects its collector's rows on every
// read. Entity reads and pushes serve that same projection, kept per pr.list scope: a versions
// read projects it again, as the full read does, and a collector change (a collection, a CI
// result) projects it and pushes the rows that changed. An ids read looks rows and versions up.
import type { PRListResult, PRStatus } from '@farmslot/protocol';
import {
  canonicalResourceJson,
  prEntityId,
  type ResourceKey,
} from '@farmslot/protocol/client-cache';
import { Methods } from '@farmslot/protocol/rpc/registry';

import { entityVersionHash } from '../../resources/entity-version-hash.js';
import { type EntitySnapshot, resourceRevisions } from '../../resources/revisions.js';
import type { PRListFetchResult, PRListProjector } from '../pr.js';

import {
  type ObservedPR,
  onPRListCollectorChange,
  peekServedPRList,
  prListRefreshInFlight,
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
  /** The list key's membership marker when this list was committed. */
  marker: number;
}

/**
 * One served row again from its newer observation, with the placement the list projection gave
 * it. Undefined when that observation alone cannot say what the list serves for the PR.
 */
export type PRRowProjector = (served: PRStatus) => Promise<PRStatus | undefined>;

interface Projection {
  queryId: string;
  project?: string;
  projector: PRListProjector;
  rowProjector: PRRowProjector;
  served?: ServedPRProjection;
  /** Order and fields of the last served list; a change moves the membership marker. */
  listing?: string;
  failure?: { error: unknown };
  /** A PR of this scope was observed while a list refresh ran; projected when it ends. */
  observed?: boolean;
  queued?: Promise<void>;
  running: Promise<void>;
}

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
  projection.observed = false;
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
  // The list key itself advances with its collector, as it always did; here only its marker moves.
  const listing = canonicalResourceJson({ order: [...rows.keys()], meta });
  if (listing !== projection.listing || hadFailure) {
    projection.listing = listing;
    resourceRevisions.advanceMembership(key);
  }
  // The marker a reply carries is the one committed with its rows, never a later one.
  projection.served = { rows, meta, marker: resourceRevisions.membershipRevision(key) };
  for (const [id, row] of rows)
    if (previous?.rows.get(id)?.version !== row.version)
      resourceRevisions.advance({ ...key, prKey: id });
  for (const id of previous?.rows.keys() ?? [])
    if (!rows.has(id)) resourceRevisions.advance({ ...key, prKey: id }, 'deleted');
}

/**
 * One PR's newer observation: its served row alone is projected and hashed. The list is
 * projected instead when the PR has no served row or the row projector cannot answer, because
 * the list projection decides what a missing or refused observation means for the list.
 */
async function computeRow(projection: Projection, observed: ObservedPR): Promise<void> {
  const served = projection.served;
  const id = prEntityId(observed);
  const held = served?.rows.get(id);
  if (!served || !held || projection.failure) return compute(projection);
  let pr: PRStatus | undefined;
  try {
    pr = await projection.rowProjector(held.pr);
  } catch {
    // A refused observation is the list projection's to report: it carries, drops or marks it.
    return compute(projection);
  }
  if (!pr || prEntityId(pr) !== id) return compute(projection);
  const version = entityVersionHash(pr);
  if (version === held.version) return;
  // The same key keeps its place in the listing; order and fields are untouched.
  const rows = new Map(served.rows);
  rows.set(id, { pr, version, bytes: Buffer.byteLength(JSON.stringify(pr)) });
  projection.served = { ...served, rows };
  resourceRevisions.advance({ ...upstreamKey(projection.project), prKey: id });
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

/** One observed row, after any running computation; a queued list projection covers it. */
function recomputeRow(projection: Projection, observed: ObservedPR): void {
  if (projection.queued) return;
  projection.running = projection.running.then(() => computeRow(projection, observed));
}

function projectionFor(
  project: string | undefined,
  projector: PRListProjector,
  rowProjector: PRRowProjector,
): Projection {
  const queryId = upstreamKey(project).queryId;
  let projection = projections.get(queryId);
  if (!projection) {
    projection = {
      queryId,
      ...(project === undefined ? {} : { project }),
      projector,
      rowProjector,
      running: Promise.resolve(),
    };
    projections.set(queryId, projection);
  }
  projection.projector = projector;
  projection.rowProjector = rowProjector;
  return projection;
}

/**
 * The served list of a scope whose collector holds a snapshot. `fresh` projects it again: runs,
 * slots, workers and configuration change a projection without telling it, so the listing a
 * client verifies against is never older than the full read's.
 */
export async function servedPRList(
  project: string | undefined,
  projector: PRListProjector,
  rowProjector: PRRowProjector,
  fresh: boolean,
): Promise<ServedPRProjection> {
  const projection = projectionFor(project, projector, rowProjector);
  if (fresh || !projection.served || projection.failure) await recompute(projection);
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

// A collector change follows into the served list of a scope some entity read has asked for:
// the collector's own refresh projects the list, one observed PR projects its row. A list
// refresh reads every PR of its scope, and each read is an observation for the other scopes
// that hold the PR: those are projected once, when no refresh is running.
onPRListCollectorChange((queryId, observed) => {
  const refreshing = prListRefreshInFlight();
  const projection = projections.get(queryId);
  if (projection?.served) {
    if (!observed) void recompute(projection);
    else if (refreshing) projection.observed = true;
    else recomputeRow(projection, observed);
  }
  if (refreshing) return;
  for (const waiting of projections.values()) if (waiting.observed) void recompute(waiting);
});

resourceRevisions.registerEntityCollection(
  (key) =>
    key.family === 'upstream' &&
    key.integration === 'github' &&
    !('prKey' in key) &&
    key.queryId.startsWith(`${Methods.PR_LIST}:`),
);

export function resetServedPRListsForTests(): void {
  projections.clear();
}
