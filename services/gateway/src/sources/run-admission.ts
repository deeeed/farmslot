import type { Run, SourceLock, SourceMaterialization } from '@farmslot/protocol';
import { type ProjectSourceContext, withProjectSources } from '@farmslot/slot-config';
import { assertSourceAttestation, sourceInputsDigest } from '@farmslot/slot-config/sources';

import type { SourceAuthority } from './authority.js';

/** Control flow only: no claimed resource or worker may exist when a plan restarts. */
export class SourcePlanRestart extends Error {}

export interface SourceAdmissionTarget {
  nodeId: string;
  slotId?: string;
  requestedSlotId?: string;
  retainedRunId?: string;
}

export interface RunSourceAdmissionDependencies {
  authority: Pick<SourceAuthority, 'lock' | 'withCurrentLock'>;
  getRun: (id: string) => Run | undefined;
  gatewayMaterialization: (lock: SourceLock) => Promise<SourceMaterialization>;
  nodeMaterialization: (nodeId: string, lock: SourceLock) => Promise<SourceMaterialization>;
  replan: (run: Run, target: SourceAdmissionTarget) => Promise<Run>;
  save: (run: Run) => Promise<void>;
}

interface PreparedRunSources {
  plan: NonNullable<Run['sourcePlan']>;
  current: () => Run;
  lock: SourceLock;
  materialization: SourceMaterialization;
}

async function preparePlannedRunSources(
  runId: string,
  target: SourceAdmissionTarget,
  deps: RunSourceAdmissionDependencies,
): Promise<PreparedRunSources> {
  const run = deps.getRun(runId);
  if (!run?.sourcePlan || run.sourceProvenance)
    throw new Error('Run has no provisional source plan');
  const current = (): Run => {
    const next = deps.getRun(runId);
    if (
      !next?.sourcePlan ||
      next.sourceProvenance ||
      next.status === 'cancelled' ||
      next.status === 'paused' ||
      (next.engineState?.generation ?? 0) !== (run.engineState?.generation ?? 0) ||
      next.sourcePlan.lock.digest !== run.sourcePlan!.lock.digest ||
      next.createdByPrincipalId !== run.createdByPrincipalId ||
      next.nativeOwnerPrincipalId !== run.nativeOwnerPrincipalId
    )
      throw new Error('Run ownership or source plan changed before admission');
    return next;
  };
  const lock = await deps.authority.lock({ project: run.project, runId, nodeId: target.nodeId });
  const materialization = await deps.gatewayMaterialization(lock);
  assertSourceAttestation(lock, 'gateway', materialization);
  current();
  const context: ProjectSourceContext = {
    project: run.project,
    pack: lock.packBindings[run.project],
    materialization,
    packs: lock.packBindings,
  };
  if (
    run.sourcePlan.lock.digest !== lock.digest ||
    run.sourcePlan.validatedSlotId !== target.slotId
  ) {
    const replanned = await withProjectSources(context, () => deps.replan(current(), target));
    await deps.authority.withCurrentLock(lock, async () => {
      current();
      if (
        replanned.id !== runId ||
        replanned.sourcePlan?.lock.digest !== lock.digest ||
        replanned.sourcePlan.validatedSlotId !== target.slotId
      )
        throw new Error('Revalidation returned a different run or source plan');
      await deps.save(replanned);
    });
    throw new SourcePlanRestart(
      'Run source inputs changed; restart selection against the new plan',
    );
  }
  return { plan: run.sourcePlan, current, lock, materialization };
}

/** Planning refresh has no node execution receipt and cannot freeze provenance. */
export async function refreshPlannedRunSources(
  runId: string,
  target: SourceAdmissionTarget,
  deps: RunSourceAdmissionDependencies,
): Promise<void> {
  await preparePlannedRunSources(runId, target, deps);
}

/** Caller serializes this with run pins. The authority serializes the final seal with all pins. */
export async function admitPlannedRunSources(
  runId: string,
  target: SourceAdmissionTarget,
  deps: RunSourceAdmissionDependencies,
): Promise<void> {
  const { plan, current, lock, materialization } = await preparePlannedRunSources(
    runId,
    target,
    deps,
  );
  const retained = target.retainedRunId ? deps.getRun(target.retainedRunId) : undefined;
  if (target.retainedRunId && (!retained?.sourceProvenance || retained.id === runId))
    throw new Error('Retained worker source inputs are unknown');
  const workerLock = retained?.sourceProvenance?.workerLock ?? plan.workerLock;
  if (sourceInputsDigest(lock) !== sourceInputsDigest(workerLock))
    throw new Error('Retained worker source inputs changed');
  const execution = await deps.nodeMaterialization(target.nodeId, lock);
  assertSourceAttestation(lock, target.nodeId, execution);
  const workerExecution =
    workerLock.digest === lock.digest
      ? execution
      : await deps.nodeMaterialization(target.nodeId, workerLock);
  assertSourceAttestation(workerLock, target.nodeId, workerExecution);
  await deps.authority.withCurrentLock(lock, async () => {
    const fresh = current();
    if (
      target.retainedRunId &&
      deps.getRun(target.retainedRunId)?.sourceProvenance?.workerLock.digest !== workerLock.digest
    )
      throw new Error('Retained worker ownership changed before source admission');
    const attemptId = `${runId}:1`;
    const receiptIds = [
      ...new Set([materialization.receipt.id, execution.receipt.id, workerExecution.receipt.id]),
    ];
    const admitted: Run = {
      ...fresh,
      sourcePlan: undefined,
      sourceProvenance: {
        state: 'locked',
        attemptId,
        lock,
        workerLock,
        receiptIds,
        bindings: fresh.sourcePlan!.bindings,
        attempts: [{ id: attemptId, receiptIds }],
      },
    };
    await deps.save(admitted);
  });
}
