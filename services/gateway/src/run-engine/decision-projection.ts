import type { PendingDecision, Run, RunDecision, RunDecisionPayload } from '@farmslot/protocol';

export function pendingDecisionForRun(
  run: Run,
  decision: RunDecision,
  payload: RunDecisionPayload | undefined = decision.payload,
): PendingDecision {
  return {
    id: decision.id,
    type: decision.type,
    slotId: run.slotId,
    title: decision.title,
    description: decision.description,
    context: {
      runId: run.id,
      project: run.project,
      flowType: run.flowType,
      ticketOrPr: run.ticketOrPr,
      ...(decision.context ?? {}),
    },
    actions: decision.actions,
    createdAt: decision.createdAt,
    ...(payload ? { payload } : {}),
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
  };
}
