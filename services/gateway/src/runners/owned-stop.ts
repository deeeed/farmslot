import type { Run } from '@farmslot/protocol';

import { loadSlotVars, readSlotRow } from '../core/index.js';
import { getRun } from '../runs/store.js';

import { stopRunnerForPark } from './session-lifecycle.js';

/** Stop only the exact saved conversations this run owns, without removing sessions. */
export async function stopRunOwnedTmuxWorkers(run: Run): Promise<void> {
  for (const context of run.agentContexts ?? []) {
    if (context.nativeSession || context.nativeSessionOwner || !context.target) continue;
    const slotId = context.slotId ?? run.slotId;
    const slot = slotId ? await readSlotRow(slotId) : null;
    if (slot && slot.current_run_id !== run.id) continue;
    if (
      !slotId ||
      !context.target.paneId ||
      !context.runner ||
      !context.runnerSessionId ||
      !context.runnerSessionPath
    )
      throw new Error(
        `Worker ${context.id} cannot be stopped without its exact pane and saved conversation identity`,
      );
    const result = await stopRunnerForPark({
      vars: await loadSlotVars(slotId),
      preservePane: true,
      beforeExit: async () => {
        const currentSlot = await readSlotRow(slotId);
        const currentRun = getRun(run.id);
        const current = currentRun?.agentContexts?.find((candidate) => candidate.id === context.id);
        if (
          currentSlot?.current_run_id !== run.id ||
          currentSlot?.slot_epoch !== slot?.slot_epoch ||
          currentRun?.engineState?.generation !== run.engineState?.generation ||
          !current ||
          current.nativeSession ||
          current.nativeSessionOwner ||
          current.runner !== context.runner ||
          current.runnerSessionId !== context.runnerSessionId ||
          current.runnerSessionPath !== context.runnerSessionPath ||
          JSON.stringify(current.target) !== JSON.stringify(context.target)
        )
          throw new Error(
            `Worker ${context.id} ownership changed before stop; exit was not delivered`,
          );
      },
      recoveryHandle: {
        version: 1,
        runnerId: context.runner,
        contextId: context.id,
        sessionId: context.runnerSessionId,
        sessionPath: context.runnerSessionPath,
        target: { ...context.target, paneId: context.target.paneId },
        model: context.model ?? null,
        capturedAt: run.createdAt,
      },
    });
    if (!result.ok) throw new Error(`Worker ${context.id} stop was not confirmed: ${result.error}`);
  }
}
