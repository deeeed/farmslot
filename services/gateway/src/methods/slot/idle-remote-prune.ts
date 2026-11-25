// methods/slot/idle-remote-prune.ts — drops remote-tracking refs whose branch origin deleted, on
// idle slots only. Release, prepare, find-slot and recovery never prune: release's
// unpushed-commit check (`--not --remotes`) still needs a merged PR's deleted branch ref.

import { SLOT_LIFECYCLE, type SlotStatus } from '@farmslot/protocol';

import { withFarmGitConfig } from '../../core/farm-git.js';
import { execOnSlot, loadSlotVars, readSlotRow } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import { loadFleetStatus } from '../../fleet/state.js';

import {
  gitMaintenanceNotes,
  REMOTE_PRUNE_INTERVAL_HOURS,
  REMOTE_PRUNE_RETRY_HOURS,
  remotePruneCommand,
} from './git-cleanup-commands.js';

/** How often the job looks for an idle slot to prune. */
export const IDLE_REMOTE_PRUNE_TICK_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 60_000;

/** When each slot may be tried again; slot-side stamps still decide after a gateway restart. */
const nextAttempt = new Map<string, number>();

export interface IdleRemotePruneDeps {
  listSlots: () => Promise<readonly SlotStatus[]>;
  readRow: typeof readSlotRow;
  run: (slotId: string, command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  now: () => number;
  log: (line: string) => void;
}

const defaultDeps: IdleRemotePruneDeps = {
  listSlots: async () => (await loadFleetStatus()).slots,
  readRow: readSlotRow,
  run: async (slotId, command) => {
    const vars = await loadSlotVars(slotId);
    return execOnSlot(vars, withFarmGitConfig(`cd ${shellQuote(vars.remoteRepo)} && { ${command}; }`), {
      timeout: COMMAND_TIMEOUT_MS,
      noRetry: true,
    });
  },
  now: Date.now,
  log: (line) => console.log(line),
};

/**
 * A slot back at idle: lifecycle `ready` with no phase (busy and held slots carry one) and no run,
 * handoff, cleanup or recovery holding it. Manual and disabled slots are never touched.
 */
async function releasedIdle(slot: SlotStatus, deps: IdleRemotePruneDeps): Promise<boolean> {
  if (slot.lifecycle !== SLOT_LIFECYCLE.ready || slot.phase != null || slot.currentRunId)
    return false;
  const row = await deps.readRow(slot.slot);
  return Boolean(
    row &&
      row.lifecycle === SLOT_LIFECYCLE.ready &&
      row.phase == null &&
      !row.current_run_id &&
      !row.handoff_run_id &&
      !row.cleanup_run_id &&
      !row.workspace_recovery,
  );
}

/**
 * One pass: at most one idle slot per machine, each prune bounded and never thrown. A failed or
 * timed-out attempt (exit 124, a dropped node) waits `REMOTE_PRUNE_RETRY_HOURS` before the next.
 */
export async function pruneIdleSlotRemoteRefs(deps: IdleRemotePruneDeps = defaultDeps): Promise<void> {
  const machines = new Set<string>();
  for (const slot of await deps.listSlots()) {
    if (machines.has(slot.machine) || (nextAttempt.get(slot.slot) ?? 0) > deps.now()) continue;
    if (!(await releasedIdle(slot, deps))) continue;
    machines.add(slot.machine);
    let retryHours = REMOTE_PRUNE_INTERVAL_HOURS;
    try {
      const result = await deps.run(slot.slot, remotePruneCommand());
      for (const note of gitMaintenanceNotes(result.stdout))
        deps.log(`[slot] ${slot.slot}: git maintenance: ${note}`);
      if (result.exitCode !== 0) {
        retryHours = REMOTE_PRUNE_RETRY_HOURS;
        deps.log(
          `[slot] ${slot.slot}: remote prune exited ${result.exitCode}: ${result.stderr.trim().split('\n').at(-1) ?? ''}`,
        );
      }
    } catch (error) {
      // A disconnected node or transport failure is reported and retried later, never thrown.
      retryHours = REMOTE_PRUNE_RETRY_HOURS;
      deps.log(`[slot] ${slot.slot}: remote prune unavailable: ${(error as Error).message}`);
    }
    nextAttempt.set(slot.slot, deps.now() + retryHours * 3_600_000);
  }
}

export function resetIdleRemotePruneForTest(): void {
  nextAttempt.clear();
}

let timer: ReturnType<typeof setInterval> | undefined;

export function startIdleRemotePrune(): void {
  if (timer) return;
  timer = setInterval(() => {
    pruneIdleSlotRemoteRefs().catch((error: unknown) => {
      console.error(`[slot] idle remote prune pass failed: ${(error as Error).message}`);
    });
  }, IDLE_REMOTE_PRUNE_TICK_MS);
  timer.unref();
}
