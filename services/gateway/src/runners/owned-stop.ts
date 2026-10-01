import type { Run } from '@farmslot/protocol';

import { execOnSlot, loadSlotVars, readSlotRow } from '../core/index.js';
import { shellQuote, tmuxShellSnippet } from '../core/tmux.js';
import { getRun } from '../runs/store.js';

import { stopRunnerForPark } from './session-lifecycle.js';
import { probeRunnerDescendantPid } from './session-process.js';

/** Stop only the exact saved conversations this run owns, without removing sessions. */
export async function stopRunOwnedTmuxWorkers(run: Run): Promise<string | null> {
  for (const context of run.agentContexts ?? []) {
    if (context.nativeSession || context.nativeSessionOwner || !context.target) continue;
    const slotId = context.slotId ?? run.slotId;
    const slot = slotId ? await readSlotRow(slotId) : null;
    if (slot && slot.current_run_id !== run.id) continue;
    if (slot?.handoff_run_id && slot.handoff_run_id !== run.id)
      return 'Another native handoff owns this slot reservation; worker cleanup deferred';
    if (!slotId) return `Worker ${context.id} has no slot ownership evidence`;
    const vars = await loadSlotVars(slotId);
    if (!context.target.paneId)
      return `Worker ${context.id} has no exact pane identity; cleanup deferred`;
    const pane = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `display-message -p -t ${shellQuote(context.target.paneId)} -F '#{session_name}\t#{pane_id}\t#{pane_pid}'`,
      ),
      { cwd: '/' },
    );
    if (pane.exitCode === 1) continue; // A historical pane that no longer exists owns nothing live.
    if (pane.exitCode !== 0) return `Worker ${context.id} pane inspection failed; cleanup deferred`;
    const [session, paneId, panePid] = pane.stdout.trim().split('\t');
    if (session !== context.target.session || paneId !== context.target.paneId)
      return `Worker ${context.id} pane ownership changed; cleanup deferred`;
    const live = await probeRunnerDescendantPid(vars, panePid, context.runner ?? undefined);
    if (live.state === 'absent') continue;
    if (live.state === 'unknown')
      return `Worker ${context.id} liveness is unknown; cleanup deferred`;
    if (
      !slotId ||
      !context.target.paneId ||
      !context.runner ||
      !context.runnerSessionId ||
      !context.runnerSessionPath
    )
      return `Worker ${context.id} cannot be stopped without its exact saved conversation identity; cleanup deferred`;
    const result = await stopRunnerForPark({
      vars,
      preservePane: true,
      beforeExit: async () => {
        const currentSlot = await readSlotRow(slotId);
        const currentRun = getRun(run.id);
        const current = currentRun?.agentContexts?.find((candidate) => candidate.id === context.id);
        if (
          currentSlot?.current_run_id !== run.id ||
          currentSlot?.slot_epoch !== slot?.slot_epoch ||
          (currentSlot?.handoff_run_id && currentSlot.handoff_run_id !== run.id) ||
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
    if (!result.ok) return `Worker ${context.id} stop was not confirmed: ${result.error}`;
  }
  return null;
}
