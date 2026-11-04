import {
  Events,
  isTerminalRunStatus,
  type Run,
  slotRecoveryEligibility,
  type SlotWorkspace,
} from '@farmslot/protocol';
import { isRecord } from '@farmslot/protocol/recipe';

import type { EventEmitter } from '../methods/slot/shared.js';

import { parksBranchCommits } from './validation-run-commits.js';

export interface RetainedIdleCheckout {
  slotId: string;
  branch: string;
  headSha: string;
}

export type SafeIdleSlotResult =
  | { kind: 'ready' }
  | { kind: 'local-work' | 'unavailable'; reason: string };

export function checkoutBeforeIdleReturn(run: Run): RetainedIdleCheckout | undefined {
  const value = run.steps.find((step) => step.name === 'prepare')?.outputs
    ?.checkoutBeforeIdleReturn;
  if (
    !isRecord(value) ||
    typeof value.slotId !== 'string' ||
    typeof value.branch !== 'string' ||
    typeof value.headSha !== 'string'
  )
    return undefined;
  return { slotId: value.slotId, branch: value.branch, headSha: value.headSha };
}

async function retainCheckout(
  slotId: string,
  workspace: SlotWorkspace,
  runId?: string,
): Promise<void> {
  const { getAllRuns, getRun, persistRunNow, updateRunStep } = await import('../runs/store.js');
  for (const run of getAllRuns()) {
    if (!isTerminalRunStatus(run.status) || !run.steps.some((step) => step.name === 'prepare'))
      continue;
    if (
      run.id !== runId &&
      run.id !== workspace.currentRunId &&
      !(run.slotId === slotId && run.branch === workspace.branch)
    )
      continue;
    // A later run on the same branch cannot rewrite historical replay evidence.
    if (checkoutBeforeIdleReturn(run) && run.id !== runId && run.id !== workspace.currentRunId)
      continue;
    const step = run.steps.find((step) => step.name === 'prepare')!;
    updateRunStep(run.id, 'prepare', {
      outputs: {
        ...step.outputs,
        checkoutBeforeIdleReturn: { slotId, branch: workspace.branch, headSha: workspace.headSha },
      },
    });
    await persistRunNow(getRun(run.id)!, 'checkout before safe idle return');
  }
}

/** No cleanup is necessary for an unowned primary checkout already at the verified default. */
function atVerifiedDefault(workspace: SlotWorkspace): boolean {
  return (
    !workspace.currentRunId &&
    !workspace.recoveryId &&
    workspace.branch === workspace.defaultBranch &&
    workspace.publication === 'baseline'
  );
}

/** Dispatch reads every free candidate at once; past this budget a candidate counts as not clean. */
export const CLEAN_IDLE_PROBE_BUDGET_MS = 8_000;

/**
 * Whether a free slot is reusable as it stands, read with status-probe budgets and no fetch:
 * HEAD matching the remote default is the positive evidence. Dispatch takes such a slot
 * without recovering anything; any doubt answers false and leaves the slot to recovery.
 */
export async function cleanIdleSlot(
  slotId: string,
  budgetMs = CLEAN_IDLE_PROBE_BUDGET_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[find-slot] clean probe of ${slotId} passed ${budgetMs} ms; not clean`);
      resolve(false);
    }, budgetMs);
  });
  try {
    return await Promise.race([readCleanIdleSlot(slotId), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function readCleanIdleSlot(slotId: string): Promise<boolean> {
  try {
    const { inspectSlotWorkspace } = await import('../methods/slot/workspace.js');
    const { loadFleetStatus } = await import('../fleet/state.js');
    const workspace = await inspectSlotWorkspace(slotId, { baselineOnly: true });
    const slot = (await loadFleetStatus(true)).slots.find((candidate) => candidate.slot === slotId);
    const eligibility = slotRecoveryEligibility(slot ? { ...slot, workspace } : undefined);
    return eligibility.allowed && !eligibility.confirmationRequired && atVerifiedDefault(workspace);
  } catch (error) {
    console.warn(`[find-slot] clean probe of ${slotId} failed: ${(error as Error).message}`);
    return false;
  }
}

/** Automatic callers use the same positive evidence and fenced recovery as fleet release. */
export async function reuseSafeIdleSlot(
  slotId: string,
  emit: EventEmitter,
  expected?: {
    epoch: number;
    runId: string | null;
    recordRunId?: string;
    /** A finished blind trial: its commits are a retained branch and its first output is frozen. */
    retainedCandidate?: boolean;
    /** Only this head may be parked (an ownerless checkout COMPLETE already released). */
    parkHeadSha?: string;
  },
): Promise<SafeIdleSlotResult> {
  try {
    // Keep the recovery graph lazy: replay also consumes the pure receipt reader.
    const { inspectSlotWorkspace } = await import('../methods/slot/workspace.js');
    const { loadFleetStatus } = await import('../fleet/state.js');
    const workspace = await inspectSlotWorkspace(slotId, { fetch: true });
    if (
      expected &&
      (workspace.epoch !== expected.epoch ||
        workspace.currentRunId !== expected.runId ||
        workspace.cleanupRunId ||
        workspace.handoffRunId)
    )
      return { kind: 'unavailable', reason: 'Slot ownership changed before idle return' };
    const fleet = await loadFleetStatus(true);
    const slot = fleet.slots.find((candidate) => candidate.slot === slotId);
    const eligibility = slotRecoveryEligibility(slot ? { ...slot, workspace } : undefined);
    if (!eligibility.allowed)
      return { kind: 'unavailable', reason: eligibility.detail ?? 'Slot is protected' };
    // A finished artifact-only run's own commits are retained output: the release parks them
    // (durable ref, SHAs on the run) and refuses if they turn out not to be the run's own.
    let parkRunId: string | undefined;
    let parkHeadSha: string | undefined;
    // Automatic reuse never parks an ownerless checkout's commits: that is an operator release.
    const localWork = eligibility.confirmationRequired || workspace.publication === 'unpushed';
    if (localWork && !expected?.retainedCandidate) {
      const { getRunWithArchived } = await import('../runs/store.js');
      const owner = expected?.recordRunId
        ? await getRunWithArchived(expected.recordRunId)
        : undefined;
      const recordedHead =
        expected?.parkHeadSha ??
        (owner?.releasedCheckout?.slotId === slotId &&
        owner.releasedCheckout.branch === workspace.branch
          ? owner.releasedCheckout.headSha
          : undefined) ??
        owner?.parkedCommits
          ?.filter((entry) => entry.slotId === slotId && entry.branch === workspace.branch)
          .at(-1)?.headSha;
      if (
        parksBranchCommits(owner) &&
        // An old branch name is not ownership: ownerless reuse needs its recorded head.
        (workspace.currentRunId === owner.id || recordedHead === workspace.headSha) &&
        !workspace.dirtyCount &&
        workspace.publication === 'unpushed' &&
        workspace.branch === owner.branch &&
        workspace.branch !== workspace.defaultBranch &&
        (!expected?.parkHeadSha || workspace.headSha === expected.parkHeadSha)
      ) {
        parkRunId = owner.id;
        parkHeadSha = recordedHead;
      } else
        return {
          kind: 'local-work',
          reason: workspace.dirtyCount ? 'dirty files' : 'unpushed commits',
        };
    }
    if (atVerifiedDefault(workspace)) return { kind: 'ready' };
    await retainCheckout(slotId, workspace, expected?.recordRunId);
    const { recoverSlotWorkspace } = await import('../methods/slot/recover-workspace.js');
    const result = await recoverSlotWorkspace(
      {
        slotId,
        release: true,
        mode: localWork ? 'force' : 'safe',
        expectedWorkspace: workspace,
      },
      emit,
      undefined,
      {
        skipRecycle: true,
        ...(parkRunId ? { parkRunId, parkHeadSha } : {}),
      },
    );
    if (result.refreshed) emit(Events.FLEET_UPDATED, { fleet: await loadFleetStatus(true) });
    return result.refreshed
      ? { kind: 'ready' }
      : {
          kind: 'unavailable',
          reason: result.detail ?? result.reason ?? 'Safe recovery did not finish',
        };
  } catch (error) {
    // A candidate failure is an explicit result: selection tries others; settlement reports retention.
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * COMPLETE releases an artifact-only run's slot ownership but keeps its checkout, so the run's
 * close or archive finds no slot to release while the picker and prepare still refuse its
 * unpushed commits (c9562e49 on mini-mmt-3). For an unowned slot still on the finished run's
 * branch, return it to idle through the same fenced recovery, parking those commits.
 */
export async function returnReleasedCheckoutToIdle(
  run: Run,
  emit: EventEmitter,
): Promise<SafeIdleSlotResult | null> {
  const released = run.releasedCheckout;
  if (
    !run.slotId ||
    !isTerminalRunStatus(run.status) ||
    !parksBranchCommits(run) ||
    released?.slotId !== run.slotId
  )
    return null;
  const { readSlotRow } = await import('../core/state.js');
  const row = await readSlotRow(run.slotId);
  if (!row || row.current_run_id || row.cleanup_run_id || row.handoff_run_id) return null;
  const result = await reuseSafeIdleSlot(run.slotId, emit, {
    epoch: Number(row.slot_epoch) || 0,
    runId: null,
    recordRunId: run.id,
    parkHeadSha: released.headSha,
  });
  if (result.kind !== 'ready')
    console.warn(
      `[slot.release] ${run.slotId}: released checkout of run ${run.id.slice(0, 8)} stays: ${result.reason}`,
    );
  return result;
}
