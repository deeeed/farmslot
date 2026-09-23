import type { Run, RuntimeCapabilityStatusResult, SlotStatus } from '@farmslot/protocol';
import { primaryRoleForFlow } from '@farmslot/protocol';

export function blockedWorkerProofReady(
  run: Run,
  status: RuntimeCapabilityStatusResult | null,
): boolean {
  const plan = status?.proofPlans[run.id];
  if (!plan) return false;
  const blockedAt = run.steps.find((step) => step.name === 'monitor')?.completedAt;
  return plan.requirements.every((requirement) =>
    status.leases.some(
      (lease) =>
        lease.capabilityId === requirement.capabilityId &&
        lease.owner.runId === run.id &&
        lease.state === 'acquired' &&
        lease.health.state === 'healthy' &&
        blockedAt &&
        lease.health.checkedAt &&
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
  const previousAttemptId =
    previous && typeof previous === 'object' && 'attemptId' in previous
      ? previous.attemptId
      : undefined;
  if (current.status !== 'running' && current.status !== 'done' && current.status !== 'complete')
    return false;
  const previousTimestamp =
    previous && typeof previous === 'object' && 'timestamp' in previous ? previous.timestamp : null;
  if (
    typeof previousTimestamp === 'string' &&
    (!Number.isFinite(Date.parse(previousTimestamp)) ||
      typeof current.timestamp !== 'string' ||
      Date.parse(current.timestamp) <= Date.parse(previousTimestamp))
  )
    return false;
  if (typeof previousTimestamp === 'string') return true;
  return (
    typeof previousAttemptId === 'string' &&
    previousAttemptId.length > 0 &&
    typeof current.attemptId === 'string' &&
    current.attemptId !== previousAttemptId
  );
}
