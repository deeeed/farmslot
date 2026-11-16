import type { ReviewChainEntry, Run } from '@farmslot/protocol';

import { reviewPRIdentity } from '../review/pr-identity.js';
import { completedDecisionExpiresAt, type RunDecisionInboxRecord } from '../runs/decision-inbox.js';

import { resourceRevisions } from './revisions.js';
import { publishWorkerResources } from './worker-changes.js';

interface RunResourceRecord
  extends
    Pick<Run, 'id'>,
    RunDecisionInboxRecord,
    Partial<Pick<Run, 'flowType' | 'prNumber' | 'engineState'>> {
  familyId?: Run['familyId'];
  repeatReviewContext?: { priorGenerations?: readonly Pick<ReviewChainEntry, 'runId'>[] } | null;
  ticketOrPr?: Run['ticketOrPr'];
  links?: Run['links'];
  prWork?: Run['prWork'];
  decisions?: readonly (Pick<Run['decisions'][number], 'id' | 'resolvedAt'> & {
    payload?: Pick<NonNullable<Run['decisions'][number]['payload']>, 'kind'> | null;
  })[];
}

export interface RunResourceSnapshot {
  id: string;
  familyId: string;
  decisionIds: string[];
  decisionExpiresAt?: number;
  /** The PR whose review-round budget this run shares (review-pr runs keep their own). */
  reviewScope?: string;
  /** An open ready gate: run.get then serves the budget of every run in its review scope. */
  readsReviewScope: boolean;
  /** Prior review generations whose records run.get reads for chain metrics. */
  priorGenerationIds: string[];
}

/**
 * run.get also serves facts of other runs: the review-round budget of the PR (while a ready gate
 * is open) and the metrics of prior review generations. Those runs' keys advance when such a
 * run changes, so run.get need not reread on every farm-wide run change. Both indexes hold only
 * runs that read other runs, and are kept by this publisher from the snapshots it receives.
 */
const scopeReaders = new Map<string, Set<string>>();
const scopeOfReader = new Map<string, string>();
const generationReaders = new Map<string, Set<string>>();
const generationsOfReader = new Map<string, string[]>();

function indexReader(snapshot: RunResourceSnapshot, removed: boolean): void {
  const scope = scopeOfReader.get(snapshot.id);
  if (scope) scopeReaders.get(scope)?.delete(snapshot.id);
  scopeOfReader.delete(snapshot.id);
  for (const prior of generationsOfReader.get(snapshot.id) ?? [])
    generationReaders.get(prior)?.delete(snapshot.id);
  generationsOfReader.delete(snapshot.id);
  if (removed) return;
  if (snapshot.readsReviewScope && snapshot.reviewScope) {
    const readers = scopeReaders.get(snapshot.reviewScope) ?? new Set<string>();
    readers.add(snapshot.id);
    scopeReaders.set(snapshot.reviewScope, readers);
    scopeOfReader.set(snapshot.id, snapshot.reviewScope);
  }
  if (snapshot.priorGenerationIds.length) {
    for (const prior of snapshot.priorGenerationIds) {
      const readers = generationReaders.get(prior) ?? new Set<string>();
      readers.add(snapshot.id);
      generationReaders.set(prior, readers);
    }
    generationsOfReader.set(snapshot.id, snapshot.priorGenerationIds);
  }
}

/** Runs whose run.get serves facts of `current`, other than `current` itself. */
function crossRunReaders(
  current: RunResourceSnapshot,
  previous?: RunResourceSnapshot,
): Set<string> {
  const readers = new Set<string>();
  for (const scope of new Set([current.reviewScope, previous?.reviewScope]))
    for (const id of (scope && scopeReaders.get(scope)) || []) readers.add(id);
  for (const id of generationReaders.get(current.id) ?? []) readers.add(id);
  readers.delete(current.id);
  return readers;
}

function reviewScopeOf(run: RunResourceRecord): string | undefined {
  if (run.flowType === 'review-pr' || run.ticketOrPr === undefined) return undefined;
  const identity = reviewPRIdentity(
    {
      ticketOrPr: run.ticketOrPr,
      links: run.links,
      prWork: run.prWork,
      flowType: run.flowType,
      prNumber: run.prNumber,
      engineState: run.engineState,
    },
    { requirePRContext: true },
  );
  return identity ? `${identity.repository.toLowerCase()}#${identity.prNumber}` : undefined;
}

/** Worker files are already readable when their owning watcher reports a change. */
export function publishProgressResources(
  slotId: string,
  runId?: string | null,
  contextId?: string,
  revisions = resourceRevisions,
): void {
  if (runId) {
    revisions.advance({ family: 'progress', runId });
    if (contextId) revisions.advance({ family: 'progress', runId, contextId });
  }
  // Slot-only readers have no recorded run to use as their progress identity.
  if (slotId) revisions.advance({ family: 'slot', slotId });
}

/**
 * Changes whenever a live run's facts change. Every run writer advances the run's resource
 * revision after the facts are readable; the few in-place writers that skip it stamp `updatedAt`.
 */
export function runChangeStamp(run: Pick<Run, 'id' | 'updatedAt'>): string {
  return `${resourceRevisions.revision({ family: 'run', runId: run.id })}|${run.updatedAt}`;
}

/** Capture before an in-place write so former membership is invalidated too. */
export function captureRunResources(run: RunResourceRecord): RunResourceSnapshot {
  const decisionExpiresAt = completedDecisionExpiresAt(run);
  const reviewScope = reviewScopeOf(run);
  return {
    id: run.id,
    familyId: run.familyId || run.id,
    decisionIds: (run.decisions ?? []).map((decision) => decision.id),
    ...(decisionExpiresAt !== undefined ? { decisionExpiresAt } : {}),
    ...(reviewScope ? { reviewScope } : {}),
    readsReviewScope: (run.decisions ?? []).some(
      (decision) => !decision.resolvedAt && decision.payload?.kind === 'ready',
    ),
    priorGenerationIds: (run.repeatReviewContext?.priorGenerations ?? []).map(
      (entry) => entry.runId,
    ),
  };
}

/** Called by the owning writer once the new facts are readable, independently of RPC emits. */
export function publishRunResources(
  current: RunResourceSnapshot,
  previous?: RunResourceSnapshot,
  kind: 'updated' | 'deleted' = 'updated',
  revisions = resourceRevisions,
): void {
  revisions.scheduleInvalidation(
    current.id,
    { family: 'decisions', scope: 'farm' },
    kind === 'deleted' ? undefined : current.decisionExpiresAt,
  );
  publishWorkerResources(undefined, revisions);
  revisions.advance({ family: 'runs', scope: 'farm' });
  revisions.advance({ family: 'run', runId: current.id }, kind);
  // Readers first, from the index before this change, then the index follows the new facts.
  for (const reader of crossRunReaders(current, previous))
    revisions.advance({ family: 'run', runId: reader });
  indexReader(current, kind === 'deleted');
  revisions.advance({ family: 'decisions', scope: 'farm' });
  for (const familyId of new Set([current.familyId, previous?.familyId])) {
    if (familyId) revisions.advance({ family: 'family', familyId });
  }
  for (const family of ['gate', 'package', 'review', 'artifacts'] as const)
    revisions.advance({ family, runId: current.id }, kind);
  const retained = new Set(current.decisionIds);
  for (const decisionId of new Set([...retained, ...(previous?.decisionIds ?? [])])) {
    const removed = kind === 'deleted' || !retained.has(decisionId);
    revisions.advance({ family: 'decision', decisionId }, removed ? 'deleted' : 'updated');
    revisions.advance(
      { family: 'gate', runId: current.id, decisionId },
      removed ? 'deleted' : 'updated',
    );
    revisions.advance(
      { family: 'package', runId: current.id, decisionId },
      removed ? 'deleted' : 'updated',
    );
  }
}
