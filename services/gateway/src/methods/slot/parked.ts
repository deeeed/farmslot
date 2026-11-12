import { randomUUID } from 'node:crypto';

import {
  DEFAULT_BRANCH,
  Events,
  isRecord,
  type SlotParkedResult,
  type SlotRecovery,
  slotRecoveryEligibility,
  slotWorkspaceIdentity,
} from '@farmslot/protocol';

import {
  execOnSlot,
  getProjectField,
  loadProjectVars,
  loadSlotVars,
  markSlotStatusIf,
  readSlotRow,
  slotReleasingFenceFields,
  updateSlotStatusIf,
} from '../../core/index.js';
import { assertNoNativeWorkerRecovery } from '../../core/native-worker-exclusion.js';
import { loadFleetStatus } from '../../fleet/state.js';
import {
  restoreSlotParkedWork,
  slotParkedInventory,
} from '../../run-lifecycle/validation-run-commits.js';

import { assertReleaseRunGuards } from './release.js';
import { activePrepareSlots, type EventEmitter } from './shared.js';
import { assertSlotNotOperatorRoot } from './slot-tracking.js';
import {
  inspectSlotWorkspace,
  invalidateSlotWorkspaceObservations,
  recoveryFromRow,
  workspaceProtectedReason,
} from './workspace.js';

export async function slotParked(value: unknown, emit: EventEmitter): Promise<SlotParkedResult> {
  if (
    !isRecord(value) ||
    typeof value.slotId !== 'string' ||
    !['list', 'restore'].includes(String(value.action))
  )
    throw new Error('slot.parked requires a slotId and list or restore action');
  const slotId = value.slotId;
  const vars = await loadSlotVars(slotId);
  if (value.action === 'list') {
    const inventory = await slotParkedInventory(vars, execOnSlot);
    return {
      action: 'list',
      receipts: inventory.receipts,
      legacy: inventory.legacy,
      summary: inventory.summary,
    };
  }
  if (typeof value.ref !== 'string') throw new Error('Restore requires an exact parked ref');
  const ref = value.ref;
  if (activePrepareSlots.has(slotId)) throw new Error('Slot is preparing or refreshing');
  assertNoNativeWorkerRecovery(slotId);
  await assertSlotNotOperatorRoot(vars, 'refresh');
  activePrepareSlots.add(slotId);
  let marker: SlotRecovery | undefined;
  let claimed = false;
  try {
    const project = await loadProjectVars(vars.projectName);
    const workspace = await inspectSlotWorkspace(slotId, { network: false });
    const status = (await loadFleetStatus(true)).slots.find((slot) => slot.slot === slotId);
    const eligible = slotRecoveryEligibility(status ? { ...status, workspace } : undefined);
    if (!eligible.allowed || workspace.currentRunId || workspace.recoveryId)
      throw new Error(
        eligible.detail ?? 'Release the current owner or finish recovery before restoring',
      );
    assertReleaseRunGuards({ slotId }, null);
    const row = await readSlotRow(slotId);
    if (!row) throw new Error('Slot disappeared');
    marker = {
      id: randomUUID(),
      identity: slotWorkspaceIdentity(workspace),
      completed: ['inspect'],
      phase: 'reset',
    };
    const identityMatches = (current: Readonly<Record<string, unknown>>) =>
      (Number(current.slot_epoch) || 0) === workspace.epoch &&
      !current.current_run_id &&
      !current.cleanup_run_id &&
      !current.handoff_run_id;
    const mark = await markSlotStatusIf(
      slotId,
      (current) =>
        identityMatches(current) &&
        current.phase !== 'releasing' &&
        current.lifecycle === 'ready' &&
        !current.workspace_recovery,
      { ...slotReleasingFenceFields(), workspace_recovery: marker },
    );
    if (!mark.applied) throw new Error('Slot ownership changed before restore');
    claimed = true;
    const recoveryId = marker.id;
    const owns = (current: Readonly<Record<string, unknown>>) =>
      identityMatches(current) &&
      current.phase === 'releasing' &&
      recoveryFromRow(current)?.id === recoveryId;
    const verify = async () => {
      const current = await readSlotRow(slotId);
      if (!current || !owns(current)) throw new Error('Slot ownership changed during restore');
      const protectedReason = await workspaceProtectedReason(slotId, current);
      if (protectedReason) throw new Error(protectedReason);
      assertReleaseRunGuards({ slotId }, null);
    };
    const restored = await restoreSlotParkedWork(
      vars,
      project.projectJson,
      getProjectField(project.projectJson, 'default_branch') || DEFAULT_BRANCH,
      ref,
      verify,
      execOnSlot,
    );
    if (
      !(await updateSlotStatusIf(slotId, owns, {
        lifecycle: row.lifecycle,
        phase: row.phase,
        releasing_since: null,
        workspace_recovery: null,
        workspace: null,
        workspace_error: null,
        branch: restored.branch,
        head_sha: restored.head,
      }))
    )
      throw new Error('Restore completed but slot registration changed; inspect the saved branch');
    emit(Events.FLEET_UPDATED, { fleet: await loadFleetStatus(true) });
    return { action: 'restore', ref, branch: restored.branch, headSha: restored.head };
  } catch (error) {
    if (claimed && marker) {
      const reason = error instanceof Error ? error.message : String(error);
      const recovery = marker;
      await updateSlotStatusIf(
        slotId,
        (row) =>
          (Number(row.slot_epoch) || 0) === recovery.identity.epoch &&
          recoveryFromRow(row)?.id === recovery.id,
        {
          lifecycle: 'held',
          phase: 'occupied',
          held_reason: `Parked restore: ${reason}`,
          workspace_recovery: { ...recovery, error: reason },
          releasing_since: null,
        },
      );
    }
    throw error;
  } finally {
    invalidateSlotWorkspaceObservations(slotId);
    activePrepareSlots.delete(slotId);
  }
}
