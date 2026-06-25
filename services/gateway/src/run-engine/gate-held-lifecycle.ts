import { PipelineSteps, type Run } from '@farmslot/protocol';

import { killSlotAgents } from '../methods/slot.js';

import { requiresPublicationApproval } from './publication-policy.js';

export function completeStepDisposition(run: Run): string | undefined {
  const step = run.steps?.find((entry) => entry.name === PipelineSteps.COMPLETE);
  const outputs = step?.outputs as { slotDisposition?: string } | undefined;
  return typeof outputs?.slotDisposition === 'string' ? outputs.slotDisposition : undefined;
}

export function isGateHeldPublicationRun(run: Run): boolean {
  if (!requiresPublicationApproval(run)) return false;
  if (completeStepDisposition(run) !== 'gate-held') return false;
  if (run.status === 'human-gating') return true;
  if (run.status === 'blocked') {
    return (run.decisions ?? []).some(
      (decision) =>
        (decision.type === 'engine_human_gate' || decision.type === 'engine_review_posting') &&
        !decision.resolvedAt,
    );
  }
  return false;
}

export async function teardownGateHeldAgentsIfNeeded(run: Run): Promise<void> {
  if (!run.slotId || completeStepDisposition(run) !== 'gate-held') return;
  await killSlotAgents(run.slotId);
}