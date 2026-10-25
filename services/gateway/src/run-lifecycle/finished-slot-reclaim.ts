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
import {
  isActiveSlotHolder,
  slotClaimBlocker,
  slotPinIsRequestOnly,
} from '../methods/dispatch/slot-scoring.js';
import type { EventEmitter } from '../methods/slot/shared.js';
import {
  detectLinkedWorktree,
  isSlotIdleBranch,
  resolveSlotTrackingBranchFromProject,
} from '../methods/slot/slot-tracking.js';
import {
  assertPrepareCommitsPublished,
  UnpublishedSlotCommitsError,
} from '../methods/slot/unmerged-work.js';
import { runSupersededSince } from '../run-engine/run-generation.js';
import { getAllRunsWithArchived, getRun } from '../runs/store.js';

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
      ((isActiveSlotHolder(run, incoming.id) && !slotPinIsRequestOnly(run, row)) ||
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

/** Reclaim a free stale checkout only after the ordinary release proves its work published. */
export async function reclaimPublishedFreeSlot(
  slotId: string,
  incoming: Pick<Run, 'id' | 'project'>,
  generation: number,
  emit: EventEmitter,
): Promise<boolean> {
  const row = await readSlotRow(slotId);
  if (!row || row.lifecycle !== 'ready' || row.current_run_id === incoming.id) return false;
  const runs = await getAllRunsWithArchived();
  const { findActiveGateHeldRunForSlot, findGateParkedRunForSlot } =
    await import('../run-engine/gate-held-lifecycle.js');
  if (
    slotClaimBlocker(row, incoming.id, (id) => runs.find((run) => run.id === id)) ||
    findActiveGateHeldRunForSlot(slotId) ||
    findGateParkedRunForSlot(slotId) ||
    runs.some(
      (run) =>
        run.id !== incoming.id &&
        run.slotId === slotId &&
        ((isActiveSlotHolder(run, incoming.id) && !slotPinIsRequestOnly(run, row)) ||
          isCompletionPrerequisiteFailure(run) ||
          isHeldForResultDecision(run)),
    )
  )
    return false;
  const owner = typeof row.current_run_id === 'string' ? row.current_run_id : undefined;
  if (owner && !runs.some((run) => run.id === owner)) return false;
  const params = { slotId, ...(owner ? { expectedRunId: owner } : {}) };
  const options = { expectedSlotEpoch: Number(row.slot_epoch) || 0 };
  const { slotRelease, slotReleasePreflight } = await import('../methods/slot/release.js');
  const preflight = await slotReleasePreflight(params, options);
  // A dirty or unpublished candidate stays intact while selection tries the next one.
  if (!preflight || preflight.unmergedWork) return false;
  // A deleted upstream alone does not prove that local commits were published.
  try {
    await assertPrepareCommitsPublished(preflight.vars, '', execOnSlot, {
      defaultBranch: preflight.defaultBranch,
      githubRepo: getProjectField(preflight.projectJson, 'ci.repo') || undefined,
      projectJson: preflight.projectJson,
    });
  } catch (error) {
    if (error instanceof UnpublishedSlotCommitsError) return false;
    throw error;
  }

  const branch = await execOnSlot(
    preflight.vars,
    `git -C ${shellQuote(preflight.vars.remoteRepo)} rev-parse --abbrev-ref HEAD`,
  );
  if (branch.exitCode !== 0)
    throw new Error(`Cannot read free slot ${slotId} branch: ${branch.stderr}`);
  const linked = await detectLinkedWorktree(preflight.vars);
  const tracking = resolveSlotTrackingBranchFromProject(
    preflight.projectJson,
    preflight.vars,
    preflight.projectVars,
    linked,
  );
  if (isSlotIdleBranch(branch.stdout.trim(), tracking, preflight.defaultBranch, linked))
    return false;
  if (runSupersededSince(getRun(incoming.id), generation)) return false;
  // Both owner-bound and ownerless candidates fence the epoch sampled before Git reads.
  const result = await slotRelease(params, emit, options);
  return result.released;
}
