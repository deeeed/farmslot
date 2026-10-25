import {
  DEFAULT_BRANCH,
  isCompletionPrerequisiteFailure,
  isHeldForResultDecision,
  isTerminalRunStatus,
  type Run,
} from '@farmslot/protocol';

import {
  execOnSlot,
  getProjectField,
  loadProjectVars,
  loadSlotVars,
  readSlotRow,
} from '../core/index.js';
import { shellQuote } from '../core/tmux.js';
import type { EventEmitter } from '../methods/slot/shared.js';
import {
  detectLinkedWorktree,
  isSlotIdleBranch,
  resolveSlotTrackingBranchFromProject,
} from '../methods/slot/slot-tracking.js';
import { getAllRunsWithArchived } from '../runs/store.js';

/** Release a finished checkout before the incoming run writes its task there. */
export async function reclaimFinishedSlot(
  slotId: string,
  incoming: Pick<Run, 'id' | 'project' | 'branch'>,
  emit: EventEmitter,
): Promise<void> {
  const row = await readSlotRow(slotId);
  if (!row || row.current_run_id === incoming.id) return;
  const owner = typeof row.current_run_id === 'string' ? row.current_run_id : undefined;
  const runs = await getAllRunsWithArchived();
  const finished = runs.filter(
    (run) =>
      run.id !== incoming.id &&
      run.slotId === slotId &&
      run.project === incoming.project &&
      (!owner || run.id === owner) &&
      isTerminalRunStatus(run.status) &&
      run.status !== 'cancelled' &&
      !isCompletionPrerequisiteFailure(run) &&
      !isHeldForResultDecision(run),
  );
  if (finished.length === 0) return;
  const [vars, projectVars] = await Promise.all([
    loadSlotVars(slotId),
    loadProjectVars(incoming.project),
  ]);
  const branchResult = await execOnSlot(
    vars,
    `git -C ${shellQuote(vars.remoteRepo)} rev-parse --abbrev-ref HEAD`,
  );
  if (branchResult.exitCode !== 0)
    throw new Error(`Cannot read selected slot ${slotId} branch: ${branchResult.stderr}`);
  const branch = branchResult.stdout.trim();
  if (!branch || branch === incoming.branch || !finished.some((run) => run.branch === branch))
    return;
  const linked = await detectLinkedWorktree(vars);
  const tracking = resolveSlotTrackingBranchFromProject(
    projectVars.projectJson,
    vars,
    projectVars,
    linked,
  );
  const defaultBranch =
    getProjectField(projectVars.projectJson, 'default_branch') || DEFAULT_BRANCH;
  if (isSlotIdleBranch(branch, tracking, defaultBranch, linked)) return;
  const live = runs.find(
    (run) =>
      run.id !== incoming.id &&
      run.slotId === slotId &&
      (!isTerminalRunStatus(run.status) ||
        (run.branch === branch &&
          (isCompletionPrerequisiteFailure(run) || isHeldForResultDecision(run)))),
  );
  if (live) throw new Error(`Slot ${slotId} is retained by run ${live.id}`);
  // Owner-bound release retains completion/park/native guards. An ownerless
  // historical checkout instead fences the epoch sampled before the Git reads.
  const { slotRelease } = await import('../methods/slot/release.js');
  const result = await slotRelease(
    { slotId, ...(owner ? { expectedRunId: owner } : {}) },
    emit,
    owner ? undefined : { expectedSlotEpoch: Number(row.slot_epoch) || 0 },
  );
  if (!result.released)
    throw new Error(`Finished slot ${slotId} cleanup refused: ${result.reason}`);
}
