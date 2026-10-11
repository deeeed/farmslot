import type { Run, RunEngineState } from '@farmslot/protocol';

import { getRun, persistRunNow, updateRun } from '../runs/store.js';

/** A new binding knows setup has not started; historical recovery does not. */
export function initialPrepareBranchState(
  run: Pick<Run, 'slotId' | 'branch' | 'engineState' | 'recoveryAttempts'>,
): RunEngineState['prepareBranch'] {
  if (
    !run.slotId ||
    !run.branch ||
    run.engineState?.prepareBranch ||
    run.engineState?.flags?.skipPrepare ||
    run.recoveryAttempts?.length
  )
    return undefined;
  return { slotId: run.slotId, branch: run.branch, started: false };
}

export async function recordInitialPrepareBranchState(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} was removed before recording its branch intent`);
  const intent = initialPrepareBranchState(run);
  if (!intent) return;
  await persistRunNow(
    updateRun(runId, { engineState: { ...run.engineState, prepareBranch: intent } }),
    'initial slot branch intent',
  );
}
