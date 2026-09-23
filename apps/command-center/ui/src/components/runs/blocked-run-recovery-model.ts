import type { Run, RuntimeCapabilityProofRequirement } from '@farmslot/protocol';

export interface BlockedWorkerProofPlan {
  version: 1;
  slotId: string;
  ownerRunId: string;
  requirements: RuntimeCapabilityProofRequirement[];
}

export function blockedWorkerProofPlanPath(run: Run): string | null {
  const signalFile = blockedWorkerSignalPath(run);
  return signalFile ? signalFile.replace(/\/SIGNAL\.json$/, '/artifacts/proof-plan.json') : null;
}

export function blockedWorkerSignalPath(run: Run): string | null {
  const signalFile = run.agentContexts?.find((context) => context.runId === run.id)?.signalFile;
  if (run.project !== 'farmslot-farm' || !signalFile) return null;
  if (
    !/^\.sandbox\/farmslot-farm\/worker-task\/(?:[a-zA-Z0-9_-]+\/)+SIGNAL\.json$/.test(signalFile)
  ) {
    return null;
  }
  return signalFile;
}

export function parseBlockedWorkerProofPlan(content: string, run: Run): BlockedWorkerProofPlan {
  const plan: unknown = JSON.parse(content);
  if (!plan || typeof plan !== 'object') throw new Error('Proof plan is not an object');
  const value = plan as Record<string, unknown>;
  if (value.version !== 1 || value.slotId !== run.slotId || value.ownerRunId !== run.id) {
    throw new Error('Proof plan does not belong to this run and slot');
  }
  if (
    !Array.isArray(value.requirements) ||
    value.requirements.length === 0 ||
    value.requirements.some(
      (requirement: unknown) =>
        !requirement ||
        typeof requirement !== 'object' ||
        typeof (requirement as Record<string, unknown>).capabilityId !== 'string' ||
        typeof (requirement as Record<string, unknown>).reason !== 'string' ||
        !['state', 'visual', 'mixed'].includes(
          String((requirement as Record<string, unknown>).mode),
        ),
    )
  ) {
    throw new Error('Proof plan has no valid capability requirements');
  }
  return plan as BlockedWorkerProofPlan;
}

export function canResumeBlockedWorkerMonitor(run: Run, signal: unknown): boolean {
  if (
    run.status !== 'blocked' ||
    run.metrics.disposition !== 'blocked' ||
    run.decisions.some((decision) => !decision.resolvedAt) ||
    run.steps.find((step) => step.name === 'monitor')?.status !== 'done' ||
    !signal ||
    typeof signal !== 'object'
  )
    return false;
  const current = signal as Record<string, unknown>;
  const previous = run.steps.find((step) => step.name === 'monitor')?.outputs?.workerSignal;
  const previousAttemptId =
    previous && typeof previous === 'object' && 'attemptId' in previous
      ? previous.attemptId
      : undefined;
  return (
    typeof previousAttemptId === 'string' &&
    previousAttemptId.length > 0 &&
    typeof current.attemptId === 'string' &&
    current.attemptId.length > 0 &&
    current.attemptId !== previousAttemptId &&
    (current.status === 'running' || current.status === 'done')
  );
}
