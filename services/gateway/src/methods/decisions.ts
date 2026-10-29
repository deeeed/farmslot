// methods/decisions.ts — decision.list, decision.resolve
// Unified: merges file-based decisions + run decisions into one list.

import type {
  DecisionListResult,
  DecisionResolveParams,
  PendingDecision,
  Run,
} from '@farmslot/protocol';

import { refreshRetrospectiveFeedback } from '../intelligence/feedback-candidates.js';
import { loadPendingDecisions, resolveFileDecision } from '../observability/fleet-monitor.js';
import { attachReviewRoundBudget } from '../review/review-round-budget.js';
import { buildRetrospectivePayload } from '../run-completion/orchestrator.js';
import { pendingDecisionForRun } from '../run-engine/decision-projection.js';
import { refreshRunGateReadiness } from '../run-engine/gate-prerequisites.js';
import { enrichDecisionsWithGateSummary } from '../run-engine/gate-summary.js';
import { reconcilePublicationPackageForInspection } from '../run-engine/publish-package-refresh.js';
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

export async function decisionList(): Promise<DecisionListResult> {
  // File-based decisions (legacy)
  const fileDecisions = await loadPendingDecisions();

  // Run decisions (from run-engine)
  const runs = getRunsWithDecisions();

  const runDecisions: PendingDecision[] = [];
  for (const run of runs) {
    // Lazy gate-summary backfill so historical gate/retrospective decisions
    // carry the consolidated narrative without a migration.
    const enrichedRun = enrichDecisionsWithGateSummary(
      await attachReviewRoundBudget(
        await reconcilePublicationPackageForInspection(await refreshRunGateReadiness(run)),
      ),
    );
    for (const d of enrichedRun.decisions) {
      if (d.resolvedAt) continue;
      let payload =
        d.type === 'retrospective' && !d.payload
          ? await buildRetrospectivePayload(enrichedRun, null)
          : d.payload;
      // Stored retrospectives froze their feedback consumption state; a rule
      // landed since must show as consumed.
      if (payload?.kind === 'retrospective')
        payload = await refreshRetrospectiveFeedback(payload, enrichedRun);
      runDecisions.push(pendingDecisionForRun(run, d, payload));
    }
  }

  return { decisions: [...fileDecisions, ...runDecisions] };
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
