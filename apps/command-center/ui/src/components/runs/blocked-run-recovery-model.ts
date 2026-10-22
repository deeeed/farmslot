import type { Run, RuntimeCapabilityStatusResult, SlotStatus } from '@farmslot/protocol';
import { blockedWorkerRecoveryStep } from '@farmslot/protocol';

const strictIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

export function blockedWorkerProofReady(
  run: Run,
  status: RuntimeCapabilityStatusResult | null,
): boolean {
  const plan = status?.proofPlans[run.id];
  if (
    !plan &&
    status &&
    status.catalog?.length === 0 &&
    !status.leases.some((lease) => lease.owner.runId === run.id)
  )
    return true;
  if (!plan || plan.slotId !== run.slotId || plan.ownerRunId !== run.id) return false;
  const blockedAt = blockedWorkerRecoveryStep(run)?.completedAt;
  if (!blockedAt || !strictIso.test(blockedAt) || !Number.isFinite(Date.parse(blockedAt)))
    return false;
  return plan.requirements.every((requirement) =>
    status.leases.some(
      (lease) =>
        lease.capabilityId === requirement.capabilityId &&
        lease.owner.runId === run.id &&
        lease.state === 'acquired' &&
        lease.health.state === 'healthy' &&
        blockedAt &&
        lease.health.checkedAt &&
        strictIso.test(lease.health.checkedAt) &&
        Date.parse(lease.health.checkedAt) > Date.parse(blockedAt),
    ),
  );
}

export function blockedWorkerOwnsSlot(
  run: Run,
  slot: Pick<SlotStatus, 'currentRunId' | 'lifecycle' | 'phase'> | undefined,
): boolean {
  return (
    slot?.currentRunId === run.id &&
    (slot.lifecycle === 'busy' || slot.lifecycle === 'held') &&
    slot.phase !== 'releasing'
  );
}

export function isRecoverableBlockedWorkerRun(run: Run): boolean {
  return (
    !run.reviewWorkspaceTarget &&
    !run.decisions.some((decision) => !decision.resolvedAt) &&
    blockedWorkerRecoveryStep(run) !== null
  );
}
