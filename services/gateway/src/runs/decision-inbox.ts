import type { Run } from '@farmslot/protocol';

export interface RunDecisionInboxRecord {
  status?: Run['status'];
  completedAt?: Run['completedAt'];
  archivedAt?: Run['archivedAt'];
  decisions?: readonly Pick<Run['decisions'][number], 'id' | 'resolvedAt'>[];
}

/** The inbox reader and its deadline notification share the existing 48-hour window. */
export function completedDecisionExpiresAt(run: RunDecisionInboxRecord): number | undefined {
  if (
    run.status !== 'done' ||
    run.archivedAt ||
    !run.completedAt ||
    !run.decisions?.some((decision) => !decision.resolvedAt)
  )
    return undefined;
  const completedAt = Date.parse(run.completedAt);
  return Number.isFinite(completedAt) ? completedAt + 48 * 60 * 60 * 1000 : undefined;
}
