import {
  DETACHED_HEAD_BRANCH,
  hasLiveParkRecord,
  parkOriginalSlotId,
  remoteBranchRefspec,
  type Run,
  SLOT_DESTRUCTIVE_OPS,
  type SlotStatus,
  TERMINAL_RUN_STATUSES,
} from '@farmslot/protocol';

import { loadSlotVars } from '../../core/config.js';
import { execOnSlot, isLocal } from '../../core/exec.js';
import {
  claimSlotStatusIf,
  readSlotRow,
  SLOT_PHASE_RELEASING,
  SLOT_RELEASING_SINCE,
  slotReleasingFenceFields,
  updateSlotStatusIf,
} from '../../core/state.js';
import { shellQuote } from '../../core/tmux.js';
import { getNode } from '../../fleet/machine-registry.js';
import { isNodeTransportUnavailableError } from '../../fleet/node-rpc.js';
import { loadFleetStatus } from '../../fleet/state.js';
import { getAllRuns, getAllRunsWithArchived } from '../../runs/store.js';
import { assertSlotNotOperatorRoot } from '../slot/slot-tracking.js';

import { slotBranchCheckoutBlocker } from './slot-scoring.js';

type HolderRun = Pick<Run, 'id' | 'slotId' | 'status' | 'park'>;

function idleBranchHolderRow(row: Readonly<Record<string, unknown>>): boolean {
  return (
    row.lifecycle === 'ready' &&
    row.agent === 'idle' &&
    !row.current_run_id &&
    !row.current_family_id &&
    !row.handoff_run_id &&
    row.phase !== SLOT_PHASE_RELEASING
  );
}

export function branchHolderIsIdle(slot: SlotStatus, runs: readonly HolderRun[]): boolean {
  return (
    idleBranchHolderRow({
      lifecycle: slot.lifecycle,
      agent: slot.agent,
      current_run_id: slot.currentRunId,
      current_family_id: slot.currentFamilyId,
      phase: slot.phase,
    }) &&
    !slot.missingFromPool &&
    !runs.some(
      (run) =>
        (run.slotId === slot.slot && !TERMINAL_RUN_STATUSES.includes(run.status)) ||
        (hasLiveParkRecord(run) &&
          run.park &&
          parkOriginalSlotId(run.park, run.slotId) === slot.slot),
    )
  );
}

/** Same non-destructive detach as free-slot parking; the branch ref and untracked files survive. */
export function branchHolderGitCommand(repo: string, branch: string, detach = false): string {
  const commands = [
    `cd ${shellQuote(repo)}`,
    `git check-ref-format --branch ${shellQuote(branch)} >/dev/null`,
    ...(detach ? [`git fetch origin ${shellQuote(remoteBranchRefspec(branch))}`] : []),
    `[ "$(git symbolic-ref --short HEAD)" = ${shellQuote(branch)} ]`,
    'tracked=$(git status --porcelain --untracked-files=no)',
    '[ -z "$tracked" ]',
    `git merge-base --is-ancestor HEAD ${shellQuote(`refs/remotes/origin/${branch}`)}`,
    ...(detach ? ['git checkout --detach HEAD'] : []),
    'git rev-parse HEAD',
  ];
  return commands.join(' && ');
}

/** Preview only reads Git. Dispatch must recheck under an ownership fence before detaching. */
export async function inspectReleasableBranchHolders(
  slots: readonly SlotStatus[],
  project: string,
  branch?: string | null,
  candidateSlotIds?: readonly string[] | null,
): Promise<Set<string>> {
  const eligible = new Set<string>();
  if (!branch) return eligible;
  const relevantMachines = new Set(
    slots
      .filter(
        (slot) =>
          slot.project === project &&
          slot.linkedWorktree &&
          slot.branch !== branch &&
          (!candidateSlotIds || candidateSlotIds.includes(slot.slot)),
      )
      .map((slot) => slot.machine),
  );
  const runs = await getAllRunsWithArchived();
  for (const slot of slots) {
    if (
      !relevantMachines.has(slot.machine) ||
      slot.project !== project ||
      !slot.linkedWorktree ||
      slot.branch !== branch ||
      !branchHolderIsIdle(slot, runs)
    )
      continue;
    const vars = await loadSlotVars(slot.slot);
    if (!isLocal(vars.host, vars.machine) && !getNode(vars.machine)) continue;
    const row = await readSlotRow(slot.slot);
    if (row && !idleBranchHolderRow(row)) continue;
    try {
      await assertSlotNotOperatorRoot(vars, SLOT_DESTRUCTIVE_OPS.release);
      const result = await execOnSlot(vars, branchHolderGitCommand(vars.remoteRepo, branch), {
        timeout: 15_000,
      });
      if (result.exitCode === 0) eligible.add(slot.slot);
    } catch (error) {
      // A node that disappears during the read cannot authorize release; other candidates remain usable.
      if (!isNodeTransportUnavailableError(error)) throw error;
    }
  }
  return eligible;
}

export async function releaseBranchHolderForSelection(
  slotId: string,
  branch?: string | null,
): Promise<void> {
  if (!branch) return;
  const fleet = await loadFleetStatus();
  const selected = fleet.slots.find((slot) => slot.slot === slotId);
  if (!selected) throw new Error(`Selected slot ${slotId} is unavailable`);
  const holder = slotBranchCheckoutBlocker(selected, fleet.slots, branch);
  if (!holder) return;
  const runs = await getAllRunsWithArchived();
  const refuse = () =>
    new Error(
      `Branch ${branch} is held by slot ${holder.slot}; release requires an idle, unowned, unparked workspace with clean tracked files and pushed HEAD`,
    );
  if (!branchHolderIsIdle(holder, runs)) throw refuse();
  let restoration: Record<string, unknown> | undefined;
  const vars = await loadSlotVars(holder.slot);
  await assertSlotNotOperatorRoot(vars, SLOT_DESTRUCTIVE_OPS.release);
  const idleRow = (row: Readonly<Record<string, unknown>>) => {
    if (!idleBranchHolderRow(row) || !branchHolderIsIdle(holder, [...runs, ...getAllRuns()]))
      return false;
    // Snapshot in the successful CAS, so a prior release cannot leave a stale busy restoration.
    restoration = {
      lifecycle: row.lifecycle,
      phase: row.phase,
      [SLOT_RELEASING_SINCE]: row[SLOT_RELEASING_SINCE] ?? null,
    };
    return true;
  };
  const claim = await claimSlotStatusIf(holder.slot, idleRow, slotReleasingFenceFields());
  if (!claim.claimed) throw refuse();
  let head: string | undefined;
  let restored = false;
  try {
    if (!branchHolderIsIdle(holder, [...runs, ...getAllRuns()])) throw refuse();
    const result = await execOnSlot(vars, branchHolderGitCommand(vars.remoteRepo, branch, true), {
      timeout: 30_000,
    });
    if (result.exitCode !== 0) throw refuse();
    head = result.stdout.trim().split('\n').at(-1);
  } finally {
    restored = await updateSlotStatusIf(
      holder.slot,
      (row) => row.slot_epoch === claim.epoch && row.phase === SLOT_PHASE_RELEASING,
      {
        ...restoration,
        ...(head ? { branch: DETACHED_HEAD_BRANCH, head_sha: head } : {}),
      },
    );
  }
  if (!restored)
    throw new Error(
      `Slot ${holder.slot} ownership changed during branch release; refresh before dispatch`,
    );
  holder.branch = DETACHED_HEAD_BRANCH;
  if (head) holder.headSha = head;
}
