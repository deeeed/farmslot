import type { PendingDecision, Run } from '@farmslot/protocol';

import { extractRunArtifactManifest } from './artifact-url';

type DecisionRunContextLike = Pick<PendingDecision, 'context' | 'runMeta' | 'slotId'>;

export function decisionRunId(
  decision: Pick<PendingDecision, 'context' | 'runMeta'> | null,
): string | null {
  if (!decision) return null;
  return decision.runMeta?.runId ?? stringContextValue(decision.context, 'runId');
}

export function enrichDecisionWithRunContext<TDecision extends DecisionRunContextLike>(
  decision: TDecision | null,
  run: Run | null,
): TDecision | null {
  if (!decision || !run) return decision;
  return {
    ...decision,
    slotId: decision.slotId ?? run.slotId,
    context: {
      ...decision.context,
      runId: run.id,
      familyId: run.familyId,
      ticketOrPr: run.ticketOrPr,
      slotId: run.slotId,
      project: run.project,
      artifactManifest: extractRunArtifactManifest(run),
    },
    runMeta: {
      ...decision.runMeta,
      runId: run.id,
      familyId: run.familyId,
      flowType: run.flowType,
      ticketOrPr: run.ticketOrPr,
      ...(run.prNumber ? { prNumber: run.prNumber } : {}),
      ...(run.branch ? { branch: run.branch } : {}),
      ...(run.metrics?.runner ? { runner: run.metrics.runner } : {}),
      ...(run.metrics?.model ? { model: run.metrics.model } : {}),
      ...(run.summary ? { summary: run.summary } : {}),
    },
  } as TDecision;
}

function stringContextValue(
  context: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = context?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}
