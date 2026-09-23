import type { Run, RuntimeCapabilityStatusResult, SlotStatus } from '@farmslot/protocol';
import { primaryRoleForFlow } from '@farmslot/protocol';

const strictIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

export function blockedWorkerProofReady(
  run: Run,
  status: RuntimeCapabilityStatusResult | null,
): boolean {
  const plan = status?.proofPlans[run.id];
  if (!plan || plan.slotId !== run.slotId || plan.ownerRunId !== run.id) return false;
  const blockedAt = run.steps.find((step) => step.name === 'monitor')?.completedAt;
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
  const monitor = run.steps.find((step) => step.name === 'monitor');
  return (
    run.status === 'blocked' &&
    run.metrics.disposition === 'blocked' &&
    !run.decisions.some((decision) => !decision.resolvedAt) &&
    monitor?.status === 'done' &&
    !!monitor.outputs?.workerSignal
  );
}

export function canResumeBlockedWorkerMonitor(run: Run, signal: unknown): boolean {
  if (!isRecoverableBlockedWorkerRun(run) || !signal || typeof signal !== 'object') return false;
  const current = signal as Record<string, unknown>;
  const context =
    run.agentContexts?.find((entry) => entry.role === primaryRoleForFlow(run.flowType)) ??
    run.agentContexts?.[0];
  if (
    context &&
    ((current.role && current.role !== context.role) ||
      (current.contextId && current.contextId !== context.id))
  )
    return false;
  const previous = run.steps.find((step) => step.name === 'monitor')?.outputs?.workerSignal;
  if (current.status !== 'running' && current.status !== 'done' && current.status !== 'complete')
    return false;
  const previousTimestamp =
    previous && typeof previous === 'object' && 'timestamp' in previous ? previous.timestamp : null;
  if (
    typeof previousTimestamp !== 'string' ||
    typeof current.timestamp !== 'string' ||
    !strictIso.test(previousTimestamp) ||
    !strictIso.test(current.timestamp)
  )
    return false;
  const previousAt = Date.parse(previousTimestamp);
  const currentAt = Date.parse(current.timestamp);
  return Number.isFinite(previousAt) && Number.isFinite(currentAt) && currentAt > previousAt;
}
