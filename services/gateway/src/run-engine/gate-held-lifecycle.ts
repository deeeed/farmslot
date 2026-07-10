import { isTerminalRunStatus, PipelineSteps, type Run } from '@farmslot/protocol';

import { killSlotAgents } from '../methods/slot/release.js';
import { listRuns } from '../runs/store.js';

import { requiresPublicationApproval } from './publication-policy.js';

export function completeStepDisposition(run: Run): string | undefined {
  const step = run.steps?.find((entry) => entry.name === PipelineSteps.COMPLETE);
  const outputs = step?.outputs as { slotDisposition?: string } | undefined;
  return typeof outputs?.slotDisposition === 'string' ? outputs.slotDisposition : undefined;
}

export function blocksGateHeldSlotRelease(run: Run): boolean {
  if (!requiresPublicationApproval(run)) return false;
  if (completeStepDisposition(run) !== 'gate-held') return false;
  if (isTerminalRunStatus(run.status)) return false;
  if (isGateHeldPublicationRun(run)) return true;
  const finalizeStep = run.steps?.find((entry) => entry.name === PipelineSteps.FINALIZE);
  return !finalizeStep || finalizeStep.status !== 'done';
}

export function findActiveGateHeldRunForSlot(slotId: string): Run | undefined {
  const { runs } = listRuns({ active: true });
  return runs.find((run) => run.slotId === slotId && blocksGateHeldSlotRelease(run));
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

export function shouldTeardownGateHeldAgents(run: Run): boolean {
  if (!run.slotId || completeStepDisposition(run) !== 'gate-held') return false;
  const finalizeStep = run.steps?.find((entry) => entry.name === PipelineSteps.FINALIZE);
  return finalizeStep?.status === 'done';
}

export async function teardownGateHeldAgentsIfNeeded(run: Run): Promise<void> {
  if (!shouldTeardownGateHeldAgents(run)) return;
  const slotId = run.slotId;
  if (!slotId) return;
  await killSlotAgents(slotId);
}
