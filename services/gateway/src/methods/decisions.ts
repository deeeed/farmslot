// methods/decisions.ts — decision.list, decision.resolve
// Unified: merges file-based decisions + run decisions into one list.

import { unlink } from 'node:fs/promises';

import type {
  DecisionListResult,
  DecisionResolveParams,
  PendingDecision,
  Run,
} from '@farmslot/protocol';

import { loadPendingDecisions } from '../observability/fleet-monitor.js';
import { buildRetrospectivePayload } from '../run-completion/orchestrator.js';
import { enrichDecisionsWithGateSummary } from '../run-engine/gate-summary.js';
import { listRuns } from '../runs/store.js';

import { runResolveDecision } from './run.js';

/** Active runs + recently completed runs that still have unresolved decisions (48h window). */
function getRunsWithDecisions(): Run[] {
  const { runs: activeRuns } = listRuns({ active: true });
  const recentDoneRuns = listRuns({}).runs.filter(
    (r) =>
      r.status === 'done' &&
      r.decisions?.some((d) => !d.resolvedAt) &&
      r.completedAt &&
      Date.now() - new Date(r.completedAt).getTime() < 48 * 60 * 60 * 1000,
  );
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
    const enrichedRun = enrichDecisionsWithGateSummary(run);
    for (const d of enrichedRun.decisions) {
      if (d.resolvedAt) continue;
      const payload =
        d.type === 'retrospective' && !d.payload
          ? await buildRetrospectivePayload(enrichedRun, null)
          : d.payload;
      runDecisions.push({
        id: d.id,
        type: d.type as PendingDecision['type'],
        slotId: run.slotId,
        title: d.title,
        description: d.description,
        context: {
          runId: run.id,
          project: run.project,
          flowType: run.flowType,
          ticketOrPr: run.ticketOrPr,
          ...(d.context ?? {}),
        },
        actions: d.actions,
        createdAt: d.createdAt,
        payload,
        runMeta: {
          runId: run.id,
          familyId: run.familyId,
          flowType: run.flowType,
          ticketOrPr: run.ticketOrPr,
          prNumber: run.prNumber ?? undefined,
          branch: run.branch ?? undefined,
          runner: run.metrics.runner ?? undefined,
          model: run.metrics.model ?? undefined,
          summary: run.summary ?? undefined,
        },
      });
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
  const decisions = await loadPendingDecisions();
  const decision = decisions.find((d) => d.id === params.decisionId);
  if (!decision) {
    throw new Error(`Decision not found: ${params.decisionId}`);
  }

  const action = decision.actions.find((a) => a.id === params.actionId);
  if (!action) {
    throw new Error(`Action not found: ${params.actionId}`);
  }

  try {
    if (params.decisionId.endsWith('.json')) {
      await unlink(params.decisionId);
    }
  } catch {
    // File may already be gone
  }

  return { resolved: true };
}
