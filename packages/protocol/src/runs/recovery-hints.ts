import type { Run } from '../contracts/runs.js';

export function runRecoveryHints(run: Pick<Run, 'status' | 'decisions'>): string[] {
  if (!['blocked', 'paused', 'failed'].includes(run.status)) return [];
  return run.decisions
    .filter((decision) => !decision.resolvedAt)
    .map(
      (decision) =>
        `Pending decision ${decision.id}. Actions: ${decision.actions.map((action) => action.id).join(', ')}. ${decision.actions.map((action) => `farmslot decision resolve ${decision.id} ${action.id}`).join('; ')}`,
    );
}
