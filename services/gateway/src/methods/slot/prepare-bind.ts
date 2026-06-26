import type { SlotPrepareParams } from '@farmslot/protocol';

import { type SlotVars,updateSlotStatusIf } from '../../core/index.js';
import { pushRunRecipeToSlot } from '../../run-completion/artifact-mirror.js';
import { getRun } from '../../runs/store.js';

import type { PrepareStream } from './prepare-stream.js';

export async function bindRunToSlot(
  params: Pick<SlotPrepareParams, 'slotId' | 'bindRunId' | 'rebind'>,
  vars: SlotVars,
  step: PrepareStream['step'],
): Promise<void> {
  if (!params.bindRunId) return;
  const boundRun = getRun(params.bindRunId);
  if (boundRun && boundRun.project !== vars.projectName) {
    throw new Error(
      `Cannot bind run ${params.bindRunId.slice(0, 8)} to ${params.slotId}: run project '${boundRun.project}' does not match slot project '${vars.projectName}'.`,
    );
  }
  const bound = await updateSlotStatusIf(
    params.slotId,
    (slot) =>
      slot.agent !== 'working' &&
      (params.rebind || !slot.current_run_id || slot.current_run_id === params.bindRunId),
    { current_run_id: params.bindRunId },
  );
  if (!bound) {
    throw new Error(
      `Cannot bind run ${params.bindRunId.slice(0, 8)} to ${params.slotId}: slot is busy or owned by another run (pass rebind to take over an idle slot).`,
    );
  }
  step('bind', `Bound run ${params.bindRunId.slice(0, 8)} to ${params.slotId}`);
  if (boundRun) {
    const synced = await pushRunRecipeToSlot(boundRun, vars);
    step('bind', `Synced ${synced} recipe workflow file(s) to slot`);
  }
}