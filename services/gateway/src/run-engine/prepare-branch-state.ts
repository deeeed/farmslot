import {
  resolveRunSlotId,
  type Run,
  type RunEngineState,
  type SlotStatus,
} from '@farmslot/protocol';

import { getRun, persistRunNow, updateRun } from '../runs/store.js';

/** Save historical identity before replay releases or rebinds its slot. Unknown
 * setup/launch history stays unknown; migration cannot grant fresh-branch authority. */
export async function recordRecoveryBranchSource(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} was removed before recording its recovery source`);
  if (run.engineState?.prepareBranch) return;
  const slotId = resolveRunSlotId(run);
  if (!run.branch && !slotId) return;
  await persistRunNow(
    updateRun(runId, {
      engineState: {
        ...run.engineState,
        prepareBranch: { slotId: slotId ?? undefined, branch: run.branch ?? undefined },
      },
    }),
    'historical recovery branch source',
  );
}

/** Source access is unnecessary only when neither setup nor worker launch began. */
export function recoverySourceNeedsVerification(run: Pick<Run, 'branch' | 'engineState'>): boolean {
  return !(
    run.engineState?.prepareBranch?.branch === run.branch &&
    run.engineState.prepareBranch.started === false &&
    run.engineState.workerLaunchStarted === false
  );
}

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

/** Record a first name without discarding historical source identity or setup uncertainty. */
export async function updateRunSummaryAndBranch(
  runId: string,
  patch: Pick<Partial<Run>, 'summary' | 'branch'>,
): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} was removed before assigning its branch`);
  if (!run.branch && patch.branch && run.engineState?.workerLaunchStarted !== false) {
    throw new Error(
      'Replay cannot assign a first branch after an unknown or started worker launch. Restore the original run branch identity before retrying; existing work was preserved.',
    );
  }
  const priorSource = run.engineState?.prepareBranch;
  const intent =
    !run.branch && patch.branch
      ? priorSource && !priorSource.branch
        ? { ...priorSource, branch: patch.branch }
        : initialPrepareBranchState({ ...run, ...patch }, true)
      : undefined;
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

/** Recovery continues worker-owned work in every flow. Non-review flows,
 * including update-branch, retain the local tip; integration uses mergeMain or
 * the worker's workflow. Review/QA prepare can refresh a clean tree safely. */
export function prepareReusesRunBranch(run: Pick<Run, 'recoveryAttempts'>): boolean {
  return run.recoveryAttempts?.at(-1)?.status === 'started';
}

/** Worker launch history survives step resets and slot changes. Branch setup
 * intent alone cannot prove a historical worker never ran. */
export function recoveryMayInitializeBranch(run: Pick<Run, 'branch' | 'engineState'>): boolean {
  const state = run.engineState;
  return (
    !!run.branch &&
    state?.prepareBranch?.branch === run.branch &&
    state?.workerLaunchStarted === false
  );
}

/** Persist before fresh launch, nudge or retained handoff. A failed/uncertain
 * launch remains conservative; replay must never infer absence from reset steps. */
export async function recordWorkerLaunchStarting(runId: string): Promise<Run> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} was removed before worker launch`);
  if (run.engineState?.workerLaunchStarted === true) return run;
  const updated = updateRun(runId, {
    engineState: { ...run.engineState, workerLaunchStarted: true },
  });
  await persistRunNow(updated, 'worker launch starting');
  return updated;
}

/** A pre-worker failure retains its prepared branch on the original slot.
 * Prefer that provenance on find-slot recovery instead of scoring it stale
 * and binding a different clone which cannot restore unpublished work. */
export function recoveryWorkAffinitySlot(
  run: Run,
  eligibleSlots: readonly SlotStatus[],
): SlotStatus | null {
  const state = run.engineState?.prepareBranch;
  if (
    !prepareReusesRunBranch(run) ||
    !['dev', 'fix-bug'].includes(run.flowType) ||
    !state?.slotId ||
    !state.started ||
    state.branch !== run.branch
  )
    return null;
  return (
    eligibleSlots.find(
      (slot) =>
        slot.slot === state.slotId &&
        slot.project === run.project &&
        slot.branch === run.branch &&
        !slot.currentRunId &&
        !slot.currentFamilyId &&
        (!run.allowedSlots?.length || run.allowedSlots.includes(slot.slot)),
    ) ?? null
  );
}
