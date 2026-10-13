import { isDeepStrictEqual } from 'node:util';

import type { Run } from '@farmslot/protocol';

/** Ownership is independent of a source plan that may intentionally be replaced. */
export function captureRunSourceOwnerFence(
  run: Run,
  getRun: (id: string) => Run | undefined,
  message: string,
): () => Run {
  const { id, project, createdByPrincipalId, nativeOwnerPrincipalId } = run;
  const generation = run.engineState?.generation ?? 0;
  return () => {
    const current = getRun(id);
    if (
      !current ||
      current.status === 'cancelled' ||
      current.status === 'paused' ||
      current.id !== id ||
      current.project !== project ||
      (current.engineState?.generation ?? 0) !== generation ||
      current.createdByPrincipalId !== createdByPrincipalId ||
      current.nativeOwnerPrincipalId !== nativeOwnerPrincipalId
    )
      throw new Error(message);
    return current;
  };
}

/** The store mutates Run in place, so the fence must outlive the original object. */
export function captureRunSourceFence(
  run: Run,
  getRun: (id: string) => Run | undefined,
  message: string,
): () => Run {
  const current = captureRunSourceOwnerFence(run, getRun, message);
  const sourcePlan = structuredClone(run.sourcePlan);
  return () => {
    const next = current();
    if (
      !next.sourcePlan ||
      next.sourceProvenance ||
      !isDeepStrictEqual(next.sourcePlan, sourcePlan)
    )
      throw new Error(message);
    return next;
  };
}
