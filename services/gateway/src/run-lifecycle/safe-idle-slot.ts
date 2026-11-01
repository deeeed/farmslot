import {
  Events,
  isTerminalRunStatus,
  type Run,
  slotRecoveryEligibility,
  type SlotWorkspace,
} from '@farmslot/protocol';
import { isRecord } from '@farmslot/protocol/recipe';

import type { EventEmitter } from '../methods/slot/shared.js';

import {
  dropParkedValidationBranch,
  type ParkedValidationCommits,
  parkValidationRunCommits,
} from './validation-run-commits.js';

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
    let parked: ParkedValidationCommits | null = null;
    if (eligibility.confirmationRequired && !expected?.retainedCandidate) {
      // A validation run's own commits are its retained output: parked under a durable ref with
      // their SHAs recorded, they no longer keep the next dispatch off this slot.
      const { getRun } = await import('../runs/store.js');
      const owner = expected?.recordRunId ? getRun(expected.recordRunId) : undefined;
      if (owner && !workspace.dirtyCount && workspace.publication === 'unpushed')
        parked = await parkValidationRunCommits(owner, slotId, workspace);
      if (!parked)
        return {
          kind: 'local-work',
          reason: workspace.dirtyCount ? 'dirty files' : 'unpushed commits',
        };
    }
    // No cleanup is necessary for an unowned primary checkout already at the verified default.
    if (
      !workspace.currentRunId &&
      !workspace.recoveryId &&
      workspace.branch === workspace.defaultBranch &&
      workspace.publication === 'baseline'
    )
      return { kind: 'ready' };
    await retainCheckout(slotId, workspace, expected?.recordRunId);
    const { recoverSlotWorkspace } = await import('../methods/slot/recover-workspace.js');
    const result = await recoverSlotWorkspace(
      {
        slotId,
        release: true,
        mode: eligibility.confirmationRequired ? 'force' : 'safe',
        expectedWorkspace: workspace,
      },
      emit,
      undefined,
      { skipRecycle: true },
    );
    if (result.refreshed && parked) await dropParkedValidationBranch(parked);
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
