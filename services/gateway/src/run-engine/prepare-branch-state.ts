import type { Run, RunEngineState } from '@farmslot/protocol';

import { getRun, persistRunNow, updateRun } from '../runs/store.js';

/** A new binding knows setup has not started; historical recovery does not. */
export function initialPrepareBranchState(
  run: Pick<Run, 'slotId' | 'branch' | 'engineState' | 'recoveryAttempts'>,
  firstAssignment = false,
): RunEngineState['prepareBranch'] {
  if (
    (!run.slotId && !firstAssignment) ||
    !run.branch ||
    run.engineState?.prepareBranch ||
    run.engineState?.flags?.skipPrepare ||
    (!firstAssignment && run.recoveryAttempts?.length)
  )
    return undefined;
  return { slotId: run.slotId ?? undefined, branch: run.branch, started: false };
}

/** A newly minted branch name is known not to have reached setup, even on retry. */
export async function updateRunSummaryAndBranch(
  runId: string,
  patch: Pick<Partial<Run>, 'summary' | 'branch'>,
): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} was removed before assigning its branch`);
  const intent =
    !run.branch && patch.branch ? initialPrepareBranchState({ ...run, ...patch }, true) : undefined;
  const updated = updateRun(runId, {
    ...patch,
    ...(intent ? { engineState: { ...run.engineState, prepareBranch: intent } } : {}),
  });
  if (intent) await persistRunNow(updated, 'first branch assignment');
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
