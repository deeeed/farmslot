// methods/decisions.ts — decision.list, decision.resolve
// Unified: merges file-based decisions + run decisions into one list.

import type { DecisionListResult, DecisionResolveParams, Run } from '@farmslot/protocol';

import { decisionIndex } from '../decisions/index.js';
import { resolveFileDecision } from '../observability/fleet-monitor.js';
import { completedDecisionExpiresAt } from '../runs/decision-inbox.js';
import { listRuns } from '../runs/store.js';

import { runResolveDecision } from './run.js';

/** Active runs + recently completed runs that still have unresolved decisions (48h window). */
function getRunsWithDecisions(): Run[] {
  const { runs: activeRuns } = listRuns({ active: true });
  const recentDoneRuns = listRuns({}).runs.filter((run) => {
    const expiresAt = completedDecisionExpiresAt(run);
    return expiresAt !== undefined && Date.now() < expiresAt;
  });
  return [...activeRuns, ...recentDoneRuns];
}

/** Returns all live decisions from the pre-enriched index. */
export async function decisionList(): Promise<DecisionListResult> {
  await decisionIndex.ready();
  return { decisions: decisionIndex.getAll() };
}

export async function decisionResolve(
  params: DecisionResolveParams,
  emit: (event: string, payload: unknown) => void = () => {},
): Promise<{ resolved: boolean }> {
  // Try run decisions
  const runs = getRunsWithDecisions();
  for (const run of runs) {
    const decision = run.decisions.find((d) => d.id === params.decisionId && !d.resolvedAt);
    if (decision) {
      // Thread the caller's emit through so RUN_DECISION_RESOLVED + RUN_UPDATED
      // events fire alongside the DECISION_RESOLVED that server.ts broadcasts;
      // otherwise family-observability + slot-card subscribers that gate on
      // run-scoped events miss the resolve when arrival was via the legacy
      // `decision.resolve` path.
      await runResolveDecision(
        {
          runId: run.id,
          decisionId: params.decisionId,
          actionId: params.actionId,
        },
        emit,
      );
      return { resolved: true };
    }
  }

  // Fall back to file-based decisions (legacy)
  await resolveFileDecision(params.decisionId, params.actionId);
  return { resolved: true };
}
