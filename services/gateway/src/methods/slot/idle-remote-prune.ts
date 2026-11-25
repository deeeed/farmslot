// methods/slot/idle-remote-prune.ts — drops remote-tracking refs whose branch origin deleted, from
// the hourly parked-work retention pass, inside that pass's fence: prepare guard held and the row
// marked releasing on its idle epoch. Release, prepare, find-slot and recovery never prune: release's
// unpushed-commit check (`--not --remotes`) still needs a merged PR's deleted branch ref.

import { withFarmGitConfig } from '../../core/farm-git.js';
import { execOnSlot, type ExecResult, loadSlotVars } from '../../core/index.js';
import { assertNoNativeWorkerRecovery } from '../../core/native-worker-exclusion.js';
import { shellQuote } from '../../core/tmux.js';

import {
  gitMaintenanceNotes,
  REMOTE_PRUNE_FAILED_EXIT,
  REMOTE_PRUNE_INTERVAL_HOURS,
  REMOTE_PRUNE_MARGIN_MINUTES,
  REMOTE_PRUNE_RETRY_HOURS,
  remotePruneCommand,
} from './git-cleanup-commands.js';
import { isOperatorRootSlot } from './slot-tracking.js';

const COMMAND_TIMEOUT_MS = 60_000;
const HOUR_MS = 3_600_000;
// The hourly pass reaches a slot a little earlier or later each time; the margin keeps a due slot
// from waiting one more pass.
const MARGIN_MS = REMOTE_PRUNE_MARGIN_MINUTES * 60_000;

/** When each slot may be tried again; the slot-side stamp still decides after a gateway restart. */
const nextAttempt = new Map<string, number>();

export interface SlotRemotePruneDeps {
  /** A lasting reason the slot can't be pruned (disabled, the operator root), or null. */
  lastingRefusal: (slotId: string) => Promise<string | null>;
  run: (slotId: string, command: string) => Promise<ExecResult>;
  now: () => number;
  log: (line: string) => void;
}

const defaultDeps: SlotRemotePruneDeps = {
  lastingRefusal: async (slotId) => {
    const vars = await loadSlotVars(slotId);
    if (!vars.slotEnabled) return 'slot is disabled';
    return (await isOperatorRootSlot(vars)) ? 'slot repo is the operator root' : null;
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
 * per slot, once an hour after a failure, each less the margin. Never throws.
 */
export async function pruneSlotRemoteRefs(
  slotId: string,
  deps: SlotRemotePruneDeps = defaultDeps,
): Promise<void> {
  if ((nextAttempt.get(slotId) ?? 0) > deps.now()) return;
  const retryAfter = (hours: number) =>
    nextAttempt.set(slotId, deps.now() + hours * HOUR_MS - MARGIN_MS);
  retryAfter(REMOTE_PRUNE_RETRY_HOURS);
  try {
    const refusal = await deps.lastingRefusal(slotId);
    if (refusal) {
      // A disabled slot or the operator root stays so for a while: ask again tomorrow.
      retryAfter(REMOTE_PRUNE_INTERVAL_HOURS);
      deps.log(`[slot] ${slotId}: remote prune skipped: ${refusal}`);
      return;
    }
    // The caller's prepare guard keeps a new recovery out; one that started before it is excluded.
    assertNoNativeWorkerRecovery(slotId);
    // On a transport error the caller's fence ends while the node may still finish the command.
    // Deletes name the value they read and wait 14 days of staleness, which bounds that.
    const result = await deps.run(slotId, remotePruneCommand());
    for (const note of gitMaintenanceNotes(result.stdout))
      deps.log(`[slot] ${slotId}: git maintenance: ${note}`);
    if (result.exitCode === 0) {
      retryAfter(REMOTE_PRUNE_INTERVAL_HOURS);
    } else if (result.exitCode !== REMOTE_PRUNE_FAILED_EXIT) {
      // The failed-prune exit already noted git's error; anything else (124 included) did not.
      deps.log(
        `[slot] ${slotId}: remote prune exited ${result.exitCode}: ${result.stderr.trim().split('\n').at(-1) ?? ''}`,
      );
    }
  } catch (error) {
    // A config read, a disconnected node or a transport failure is reported and retried after the
    // backoff.
    deps.log(`[slot] ${slotId}: remote prune unavailable: ${(error as Error).message}`);
  }
}

export function resetSlotRemotePruneForTest(): void {
  nextAttempt.clear();
}
