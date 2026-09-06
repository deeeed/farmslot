import {
  isGateParkInFlightOrFreed,
  isSlotFreedByPark,
  isTerminalRunStatus,
  PipelineSteps,
  type Run,
} from '@farmslot/protocol';

import { killSlotAgents } from '../methods/slot/release.js';
import { listRuns } from '../runs/store.js';

import { requiresPublicationApproval } from './publication-policy.js';

export { isGateParkInFlightOrFreed, isSlotFreedByPark };

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

/**
 * The gate-held run that still HOLDS `slotId`. A park-freed run is excluded: it
 * no longer occupies the slot, so it must not block the new occupant's release.
 * Its park record is protected separately by findGateParkedRunForSlot.
 */
export function findActiveGateHeldRunForSlot(slotId: string): Run | undefined {
  const { runs } = listRuns({ active: true });
  return runs.find(
    (run) => run.slotId === slotId && !isSlotFreedByPark(run) && blocksGateHeldSlotRelease(run),
  );
}

/**
 * Slots currently held by a gate park's record. They report `ready` to the
 * fleet, but their working tree holds a parked run's detached branch and their
 * release is refused, so automated sweeps must leave them alone.
 */
export function parkFreedSlotIds(): Set<string> {
  const { runs } = listRuns({ active: true });
  return new Set(runs.flatMap((run) => (run.slotId && isSlotFreedByPark(run) ? [run.slotId] : [])));
}

/**
 * The gate-held run whose park record was written against this slot and whose
 * ownership was released. Destroying the slot would destroy that record's
 * restore target, so release/reset must refuse unless forced.
 */
export function findGateParkedRunForSlot(slotId: string): Run | undefined {
  const { runs } = listRuns({ active: true });
  return runs.find(
    (run) => run.slotId === slotId && isSlotFreedByPark(run) && blocksGateHeldSlotRelease(run),
  );
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

/**
 * Whether FINALIZE should preserve the worker for CI-watch follow-ups.
 * Gate-held publication runs keep the session warm after human approval so
 * chained pr-complete / update-branch (and inline CI fixes) can reuse context.
 * Teardown is deferred to terminal failure, slotRelease, or family end.
 */
export function shouldKeepWorkerWarmThroughCiWatch(run: Run): boolean {
  if (!requiresPublicationApproval(run)) return false;
  return completeStepDisposition(run) === 'gate-held';
}

/**
 * Tear down gate-held agents only on terminal failure after FINALIZE.
 * Successful finalize → ci-watch keeps the worker warm (MANUAL-000065).
 * Pre-finalize gate failures leave the session for operator attach / cancel.
 */
export function shouldTeardownGateHeldAgents(run: Run): boolean {
  if (!run.slotId || completeStepDisposition(run) !== 'gate-held') return false;
  const finalizeStep = run.steps?.find((entry) => entry.name === PipelineSteps.FINALIZE);
  if (finalizeStep?.status !== 'done') return false;
  // Keep warm while the run is still progressing (ci-watching / completing) or
  // finished successfully — slotRelease / family terminal owns that teardown.
  return run.status === 'failed' || run.status === 'blocked' || run.status === 'cancelled';
}

export async function teardownGateHeldAgentsIfNeeded(run: Run): Promise<void> {
  if (!shouldTeardownGateHeldAgents(run)) return;
  const slotId = run.slotId;
  if (!slotId) return;
  await killSlotAgents(slotId);
}
