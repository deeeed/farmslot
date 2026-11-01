import { isTerminalRunStatus, type ParkedRunCommits, type Run } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import type { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

/**
 * An artifact-only dev or fix-bug run never pushes or publishes: its branch commits are output
 * COMPLETE already retained, not anyone's unpublished work. Left on the slot they block the next
 * dispatch (the picker and prepare refuse unpushed commits), so a release parks them instead.
 */
export function parksBranchCommits(run: Run | undefined): run is Run {
  return (
    !!run &&
    run.completionPolicy === 'artifact-only' &&
    ['dev', 'fix-bug'].includes(run.flowType) &&
    !!run.branch &&
    !!(run.startRef?.resolvedSha ?? run.worktreeHeadAtDispatch) &&
    // Only once its output is retained: COMPLETE has run, or the run has ended.
    (isTerminalRunStatus(run.status) ||
      run.steps.some(
        (step) => step.name === 'complete' && (step.status === 'running' || step.status === 'done'),
      ))
  );
}

const MARK = '__farmslot_park__';

/**
 * Park the checkout's commits when they are exactly this run's own: a clean checkout on the
 * run's branch that descends from its dispatch baseline. The head stays reachable at
 * `refs/farmslot/parked/<run>/<head>` (created, never moved) and the record is appended to
 * `run.parkedCommits` and read back before the caller may reset. Returns null, parking nothing,
 * for any other checkout.
 */
export async function parkRunBranchCommits(
  run: Run,
  vars: SlotVars,
  exec: typeof execOnSlot,
): Promise<ParkedRunCommits | null> {
  if (!parksBranchCommits(run)) return null;
  const baseSha = (run.startRef?.resolvedSha ?? run.worktreeHeadAtDispatch)!;
  const branch = run.branch!;
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  // One round trip: identify the checkout, prove the commits are the run's own, park them.
  const script = [
    `branch=$(${git} symbolic-ref --quiet --short HEAD) || exit 3`,
    `[ "$branch" = ${shellQuote(branch)} ] || exit 3`,
    `[ -z "$(${git} status --porcelain --untracked-files=all)" ] || exit 3`,
    `head=$(${git} rev-parse HEAD) || exit 3`,
    `${git} merge-base --is-ancestor ${shellQuote(baseSha)} "$head" || exit 3`,
    `ref="refs/farmslot/parked/${run.id}/$head"`,
    // An empty old value creates the ref or fails: an earlier parking is never moved.
    `${git} update-ref "$ref" "$head" '' 2>/dev/null || [ "$(${git} rev-parse "$ref")" = "$head" ] || exit 4`,
    `echo ${MARK} "$head" "$ref"`,
    `${git} rev-list "$head" --not ${shellQuote(baseSha)} --remotes`,
  ].join(' && ');
  const result = await exec(vars, script);
  if (result.exitCode === 3) return null;
  const lines = result.stdout.split('\n').filter(Boolean);
  const marker = lines.findIndex((line) => line.startsWith(`${MARK} `));
  if (result.exitCode !== 0 || marker < 0)
    throw new Error(
      `Cannot park ${branch} on ${vars.slotId}: ${(result.stderr || result.stdout).trim()}`,
    );
  const [, headSha, ref] = lines[marker].split(' ');
  const record: ParkedRunCommits = {
    slotId: vars.slotId,
    ref,
    branch,
    baseSha,
    headSha,
    commits: lines.slice(marker + 1),
    parkedAt: new Date().toISOString(),
  };
  const { getRunWithArchived, persistRunNow, updateRun } = await import('../runs/store.js');
  const current = (await getRunWithArchived(run.id)) ?? run;
  if (!current.parkedCommits?.some((entry) => entry.ref === ref)) {
    const updated = updateRun(run.id, {
      parkedCommits: [...(current.parkedCommits ?? []), record],
    });
    await persistRunNow(updated, 'branch commits parked');
  }
  // The reset discards the checkout only once the run durably names what it parked.
  const stored = await getRunWithArchived(run.id);
  if (!stored?.parkedCommits?.some((entry) => entry.ref === ref))
    throw new Error(`Cannot record the parked ${branch} commits on run ${run.id}`);
  console.log(
    `[slot.release] ${vars.slotId}: parked run ${run.id.slice(0, 8)}'s ${record.commits.length} unpushed commit(s) on ${branch} at ${ref}`,
  );
  return record;
}

/**
 * After the reset, drop the parked branch so the same ticket can be prepared again. Only an
 * unchanged branch is deleted; its commits stay reachable from the parked ref, and prepare
 * recreates the branch from it (`parkedBranchHead`).
 */
export async function dropParkedBranch(
  parked: ParkedRunCommits,
  vars: SlotVars,
  exec: typeof execOnSlot,
): Promise<string | null> {
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  const dropped = await exec(
    vars,
    `${git} update-ref -d ${shellQuote(`refs/heads/${parked.branch}`)} ${shellQuote(parked.headSha)}`,
  );
  return dropped.exitCode === 0
    ? null
    : `kept branch ${parked.branch} (it moved): ${(dropped.stderr || dropped.stdout).trim()}`;
}

/** The latest parked head of `branch` for this run on this slot, to restore it for a replay. */
export function parkedBranchHead(
  run: Pick<Run, 'parkedCommits'> | undefined,
  slotId: string,
  branch: string,
): ParkedRunCommits | undefined {
  return run?.parkedCommits
    ?.filter((entry) => entry.slotId === slotId && entry.branch === branch)
    .at(-1);
}
