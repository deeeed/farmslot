// methods/slot/idle-remote-prune.ts — drops remote-tracking refs whose branch origin deleted, on
// released idle slots only. Release, prepare, find-slot and recovery never prune: release's
// unpushed-commit check (`--not --remotes`) still needs a merged PR's deleted branch ref. The
// orphan reconciler's periodic pass starts it; the slot's prepare guard keeps a prepare out.

import { SLOT_DESTRUCTIVE_OPS, SLOT_LIFECYCLE } from '@farmslot/protocol';

import { withFarmGitConfig } from '../../core/farm-git.js';
import {
  execOnSlot,
  type ExecResult,
  loadSlotVars,
  readSlotRow,
} from '../../core/index.js';
import {
  activePrepareSlots,
  assertNoNativeWorkerRecovery,
} from '../../core/native-worker-exclusion.js';
import { shellQuote } from '../../core/tmux.js';

import {
  gitMaintenanceNotes,
  REMOTE_PRUNE_FAILED_EXIT,
  REMOTE_PRUNE_INTERVAL_HOURS,
  REMOTE_PRUNE_RETRY_HOURS,
  remotePruneCommand,
} from './git-cleanup-commands.js';
import { assertSlotNotOperatorRoot } from './slot-tracking.js';

const COMMAND_TIMEOUT_MS = 60_000;

/** When each slot may be tried again; the slot-side stamp still decides after a gateway restart. */
const nextAttempt = new Map<string, number>();
let inFlight = false;

/** The reconciler's view of a slot. */
export interface IdlePruneCandidate {
  slot: string;
  lifecycle: string;
  phase?: string | null;
  currentRunId?: string | null;
}

export interface IdleRemotePruneDeps {
  readRow: typeof readSlotRow;
  /** Throws when the slot's checkout is the gateway's operator root. */
  assertPrunable: (slotId: string) => Promise<void>;
  run: (slotId: string, command: string) => Promise<ExecResult>;
  guards: Set<string>;
  now: () => number;
  log: (line: string) => void;
}

const defaultDeps: IdleRemotePruneDeps = {
  readRow: readSlotRow,
  assertPrunable: async (slotId) => {
    assertNoNativeWorkerRecovery(slotId);
    const vars = await loadSlotVars(slotId);
    if (!vars.slotEnabled) throw new Error('slot is disabled');
    await assertSlotNotOperatorRoot(vars, SLOT_DESTRUCTIVE_OPS.refresh);
  },
  run: async (slotId, command) => {
    const vars = await loadSlotVars(slotId);
    return execOnSlot(
      vars,
      withFarmGitConfig(`cd ${shellQuote(vars.remoteRepo)} && ${command}`),
      { timeout: COMMAND_TIMEOUT_MS, noRetry: true },
    );
  },
  guards: activePrepareSlots,
  now: Date.now,
  log: (line) => console.log(line),
};

/** Lifecycle `ready` with no phase, and no run, handoff, cleanup or recovery on the status row. */
async function releasedIdle(slotId: string, deps: IdleRemotePruneDeps): Promise<boolean> {
  const row = await deps.readRow(slotId);
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
 * Prunes one due idle slot, holding its prepare guard so a prepare, refresh or recovery waits.
 * A pass already running makes this a no-op. Never throws: a failure is logged and retried after
 * `REMOTE_PRUNE_RETRY_HOURS`.
 */
export async function pruneIdleSlotRemoteRefs(
  slots: readonly IdlePruneCandidate[],
  activeSlotIds: ReadonlySet<string>,
  deps: IdleRemotePruneDeps = defaultDeps,
): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const due = slots.find(
      (slot) =>
        slot.lifecycle === SLOT_LIFECYCLE.ready &&
        slot.phase == null &&
        !slot.currentRunId &&
        !activeSlotIds.has(slot.slot) &&
        !deps.guards.has(slot.slot) &&
        (nextAttempt.get(slot.slot) ?? 0) <= deps.now(),
    );
    if (!due) return;
    const slotId = due.slot;
    nextAttempt.set(slotId, deps.now() + REMOTE_PRUNE_RETRY_HOURS * 3_600_000);
    let guarded = false;
    try {
      await deps.assertPrunable(slotId);
      // The checks awaited: a prepare may have taken the guard meanwhile.
      if (deps.guards.has(slotId)) return;
      deps.guards.add(slotId);
      guarded = true;
      if (!(await releasedIdle(slotId, deps))) return;
      const result = await deps.run(slotId, remotePruneCommand());
      for (const note of gitMaintenanceNotes(result.stdout))
        deps.log(`[slot] ${slotId}: git maintenance: ${note}`);
      if (result.exitCode === 0) {
        nextAttempt.set(slotId, deps.now() + REMOTE_PRUNE_INTERVAL_HOURS * 3_600_000);
      } else if (result.exitCode !== REMOTE_PRUNE_FAILED_EXIT) {
        // The failed-prune exit already noted git's error; anything else (124 included) did not.
        deps.log(
          `[slot] ${slotId}: remote prune exited ${result.exitCode}: ${result.stderr.trim().split('\n').at(-1) ?? ''}`,
        );
      }
    } catch (error) {
      // A disconnected node, a transport failure or a refused slot is reported and retried later.
      deps.log(`[slot] ${slotId}: remote prune unavailable: ${(error as Error).message}`);
    } finally {
      if (guarded) deps.guards.delete(slotId);
    }
  } finally {
    inFlight = false;
  }
}

export function resetIdleRemotePruneForTest(): void {
  nextAttempt.clear();
  inFlight = false;
}
