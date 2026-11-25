// methods/slot/idle-remote-prune.ts — drops remote-tracking refs whose branch origin deleted, from
// the hourly parked-work retention pass, inside that pass's fence: prepare guard held and the row
// marked releasing on its idle epoch. Release, prepare, find-slot and recovery never prune: release's
// unpushed-commit check (`--not --remotes`) still needs a merged PR's deleted branch ref.

import { SLOT_DESTRUCTIVE_OPS } from '@farmslot/protocol';

import { withFarmGitConfig } from '../../core/farm-git.js';
import { execOnSlot, type ExecResult, loadSlotVars } from '../../core/index.js';
import { assertNoNativeWorkerRecovery } from '../../core/native-worker-exclusion.js';
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
const HOUR_MS = 3_600_000;

/** When each slot may be tried again; the slot-side stamp still decides after a gateway restart. */
const nextAttempt = new Map<string, number>();

export interface SlotRemotePruneDeps {
  /** Throws when the slot can't be pruned for a lasting reason (disabled, the operator root). */
  assertPrunable: (slotId: string) => Promise<void>;
  run: (slotId: string, command: string) => Promise<ExecResult>;
  now: () => number;
  log: (line: string) => void;
}

const defaultDeps: SlotRemotePruneDeps = {
  assertPrunable: async (slotId) => {
    const vars = await loadSlotVars(slotId);
    if (!vars.slotEnabled) throw new Error('slot is disabled');
    await assertSlotNotOperatorRoot(vars, SLOT_DESTRUCTIVE_OPS.refresh);
  },
  run: async (slotId, command) => {
    const vars = await loadSlotVars(slotId);
    return execOnSlot(vars, withFarmGitConfig(`cd ${shellQuote(vars.remoteRepo)} && ${command}`), {
      timeout: COMMAND_TIMEOUT_MS,
      noRetry: true,
    });
  },
  now: Date.now,
  log: (line) => console.log(line),
};

/**
 * Prunes one slot the caller fenced (prepare guard held, row marked releasing). At most once a day
 * per slot, once an hour after a failure. Never throws.
 */
export async function pruneSlotRemoteRefs(
  slotId: string,
  deps: SlotRemotePruneDeps = defaultDeps,
): Promise<void> {
  if ((nextAttempt.get(slotId) ?? 0) > deps.now()) return;
  try {
    await deps.assertPrunable(slotId);
  } catch (error) {
    // A disabled slot or the operator root stays so for a while: ask again tomorrow.
    nextAttempt.set(slotId, deps.now() + REMOTE_PRUNE_INTERVAL_HOURS * HOUR_MS);
    deps.log(`[slot] ${slotId}: remote prune skipped: ${(error as Error).message}`);
    return;
  }
  nextAttempt.set(slotId, deps.now() + REMOTE_PRUNE_RETRY_HOURS * HOUR_MS);
  try {
    // The caller's prepare guard keeps a new recovery out; one that started before it is excluded.
    assertNoNativeWorkerRecovery(slotId);
    // On a transport error the caller's fence ends while the node may still finish the command.
    // Deletes name the value they read and wait 14 days of staleness, which bounds that.
    const result = await deps.run(slotId, remotePruneCommand());
    for (const note of gitMaintenanceNotes(result.stdout))
      deps.log(`[slot] ${slotId}: git maintenance: ${note}`);
    if (result.exitCode === 0) {
      nextAttempt.set(slotId, deps.now() + REMOTE_PRUNE_INTERVAL_HOURS * HOUR_MS);
    } else if (result.exitCode !== REMOTE_PRUNE_FAILED_EXIT) {
      // The failed-prune exit already noted git's error; anything else (124 included) did not.
      deps.log(
        `[slot] ${slotId}: remote prune exited ${result.exitCode}: ${result.stderr.trim().split('\n').at(-1) ?? ''}`,
      );
    }
  } catch (error) {
    // A disconnected node or a transport failure is reported and retried after the backoff.
    deps.log(`[slot] ${slotId}: remote prune unavailable: ${(error as Error).message}`);
  }
}

export function resetSlotRemotePruneForTest(): void {
  nextAttempt.clear();
}
