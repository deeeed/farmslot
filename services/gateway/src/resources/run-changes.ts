import type { Run } from '@farmslot/protocol';

import { completedDecisionExpiresAt, type RunDecisionInboxRecord } from '../runs/decision-inbox.js';

import { resourceRevisions } from './revisions.js';

interface RunResourceRecord extends Pick<Run, 'id'>, RunDecisionInboxRecord {
  familyId?: Run['familyId'];
}

export interface RunResourceSnapshot {
  id: string;
  familyId: string;
  decisionIds: string[];
  decisionExpiresAt?: number;
}

/** Capture before an in-place write so former membership is invalidated too. */
export function captureRunResources(run: RunResourceRecord): RunResourceSnapshot {
  const decisionExpiresAt = completedDecisionExpiresAt(run);
  return {
    id: run.id,
    familyId: run.familyId || run.id,
    decisionIds: (run.decisions ?? []).map((decision) => decision.id),
    ...(decisionExpiresAt !== undefined ? { decisionExpiresAt } : {}),
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
  revisions.advance({ family: 'runs', scope: 'farm' });
  revisions.advance({ family: 'run', runId: current.id }, kind);
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
