import {
  isTerminalRunStatus,
  type ParkedRunCommits,
  type Run,
  type SlotParkedCommits,
  slotParkedDetail,
} from '@farmslot/protocol';

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
    ownsArtifactOnlyBranch(run) &&
    // Only once its output is retained: COMPLETE has run, or the run has ended.
    (isTerminalRunStatus(run.status) ||
      run.steps.some(
        (step) => step.name === 'complete' && (step.status === 'running' || step.status === 'done'),
      ))
  );
}

/**
 * The run's branch holds only its own unpublished output. A blind trial is excluded: its
 * release restores the candidate's isolated Git and keeps that branch for comparison.
 */
export function ownsArtifactOnlyBranch(run: Run | undefined): run is Run {
  return (
    !!run &&
    run.completionPolicy === 'artifact-only' &&
    ['dev', 'fix-bug'].includes(run.flowType) &&
    !!run.branch &&
    !!(run.startRef?.resolvedSha ?? run.worktreeHeadAtDispatch) &&
    !run.engineState?.evalExperiment?.blind
  );
}

const MARK = '__farmslot_park__';

interface ParkedHead {
  branch: string;
  headSha: string;
  ref: string;
  /** Commits not on any remote (nor the base), newest first. */
  commits: string[];
}

/**
 * The one park both releases use: HEAD stays reachable at `refs/farmslot/parked/<key>/<head>`,
 * a ref that is created and never moved. Returns null, parking nothing, when the checkout fails
 * a check; throws when the ref cannot be written or names another head.
 */
async function parkHead(
  vars: SlotVars,
  exec: typeof execOnSlot,
  checks: {
    key: string;
    /** The checkout must be on this branch. */
    branch?: string;
    /** No staged, unstaged or untracked change. */
    clean?: boolean;
    /** The exact head the caller inspected; anything committed on top since is refused. */
    headSha?: string;
    /** The commits must descend from this base, which is excluded from the record. */
    baseSha?: string;
    /** Park only when HEAD holds commits the remotes lack. */
    requireCommits?: boolean;
  },
): Promise<ParkedHead | null> {
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  // One round trip: identify the checkout, check it, park it.
  const script = [
    `head=$(${git} rev-parse HEAD) || exit 3`,
    `branch=$(${git} symbolic-ref --quiet --short HEAD || echo HEAD)`,
    ...(checks.branch ? [`[ "$branch" = ${shellQuote(checks.branch)} ] || exit 3`] : []),
    ...(checks.clean
      ? [`[ -z "$(${git} status --porcelain --untracked-files=all)" ] || exit 3`]
      : []),
    ...(checks.headSha ? [`[ "$head" = ${shellQuote(checks.headSha)} ] || exit 3`] : []),
    ...(checks.baseSha
      ? [`${git} merge-base --is-ancestor ${shellQuote(checks.baseSha)} "$head" || exit 3`]
      : []),
    `commits=$(${git} rev-list "$head" --not ${checks.baseSha ? `${shellQuote(checks.baseSha)} ` : ''}--remotes) || exit 4`,
    ...(checks.requireCommits ? ['[ -n "$commits" ] || exit 3'] : []),
    `ref="refs/farmslot/parked/${checks.key}/$head"`,
    `${git} check-ref-format "$ref" || exit 4`,
    // An empty old value creates the ref or fails: an earlier parking is never moved.
    `${git} update-ref "$ref" "$head" '' 2>/dev/null || [ "$(${git} rev-parse "$ref")" = "$head" ] || exit 4`,
    `echo ${MARK} "$head" "$branch" "$ref"`,
    `printf '%s\\n' "$commits"`,
  ].join(' && ');
  const result = await exec(vars, script);
  if (result.exitCode === 3) return null;
  const lines = result.stdout.split('\n').filter(Boolean);
  const marker = lines.findIndex((line) => line.startsWith(`${MARK} `));
  if (result.exitCode !== 0 || marker < 0)
    throw new Error(
      `Cannot park the commits on ${vars.slotId}: ${(result.stderr || result.stdout).trim()}`,
    );
  const [, headSha, branch, ref] = lines[marker].split(' ');
  return { branch, headSha, ref, commits: lines.slice(marker + 1) };
}

/**
 * Park the checkout's commits when they are exactly this run's own: a clean checkout on the
 * run's branch that descends from its dispatch baseline. The head stays reachable at
 * `refs/farmslot/parked/<run>/<head>` (created, never moved) and the record is appended to
 * `run.parkedCommits` durably before the caller may reset. Returns null, parking nothing, for
 * any other checkout. A named discard parks whatever the run's phase: its output is going.
 */
export async function parkRunBranchCommits(
  run: Run,
  vars: SlotVars,
  exec: typeof execOnSlot,
  checks: { defaultBranch: string; headSha?: string; discard?: boolean },
): Promise<ParkedRunCommits | null> {
  if (
    !(checks.discard ? ownsArtifactOnlyBranch(run) : parksBranchCommits(run)) ||
    run.branch === checks.defaultBranch
  )
    return null;
  const baseSha = (run.startRef?.resolvedSha ?? run.worktreeHeadAtDispatch)!;
  const branch = run.branch!;
  const parked = await parkHead(vars, exec, {
    key: run.id,
    branch,
    clean: true,
    // An ownerless return names the head the run left: anything committed on top since is not its.
    headSha: checks.headSha,
    baseSha,
  });
  if (!parked) return null;
  const record: ParkedRunCommits = {
    slotId: vars.slotId,
    ref: parked.ref,
    branch,
    baseSha,
    headSha: parked.headSha,
    commits: parked.commits,
    parkedAt: new Date().toISOString(),
  };
  // The reset discards the checkout only once the run, live or archived, durably names what it
  // parked; a failed write throws before any reset.
  const { recordParkedRunCommits } = await import('../runs/store.js');
  await recordParkedRunCommits(run.id, record);
  console.log(
    `[slot.release] ${vars.slotId}: parked run ${run.id.slice(0, 8)}'s ${record.commits.length} unpushed commit(s) on ${branch} at ${record.ref}`,
  );
  return record;
}

/** A ref component from a slot id: anything but letters, digits, `_` and `-` becomes `-`. */
function refSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-');
}

/**
 * An ownerless slot's unpushed commits have no run to record them, so the same park keys them
 * by slot: `refs/farmslot/parked/manual-<slot>-<ts>/<head>`. Only the head the operator
 * inspected is parked; returns null when HEAD moved or holds nothing the remotes lack.
 */
export async function parkSlotCommits(
  vars: SlotVars,
  exec: typeof execOnSlot,
  checks: { headSha: string; now?: Date },
): Promise<SlotParkedCommits | null> {
  const stamp = (checks.now ?? new Date()).toISOString().replace(/[-:.]/g, '');
  const parked = await parkHead(vars, exec, {
    key: `manual-${refSafe(vars.slotId)}-${stamp}`,
    headSha: checks.headSha,
    requireCommits: true,
  });
  if (!parked) return null;
  const report = { ref: parked.ref, branch: parked.branch, commits: parked.commits.length };
  console.log(`[slot.release] ${vars.slotId}: ${slotParkedDetail(report)}`);
  return report;
}

/**
 * After the reset, drop the parked branch so the same ticket can be prepared again. Only an
 * unchanged branch is deleted; its commits stay reachable from the parked ref, and prepare
 * recreates the branch from it (`restoreParkedBranch`).
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

/**
 * A replay's prepare restores the run's dropped branch at its latest parked head on this slot.
 * The branch is created, never moved: returns null if there is no parking or the branch exists.
 */
export async function restoreParkedBranch(
  run: Pick<Run, 'parkedCommits'> | undefined,
  vars: SlotVars,
  branch: string,
  exec: typeof execOnSlot,
): Promise<ParkedRunCommits | null> {
  const parked = parkedBranchHead(run, vars.slotId, branch);
  if (!parked) return null;
  const restored = await exec(
    vars,
    `git -C ${shellQuote(vars.remoteRepo)} update-ref ${shellQuote(`refs/heads/${branch}`)} ${shellQuote(parked.headSha)} ''`,
  );
  return restored.exitCode === 0 ? parked : null;
}

/** The latest parked head of `branch` for this run on this slot. */
function parkedBranchHead(
  run: Pick<Run, 'parkedCommits'> | undefined,
  slotId: string,
  branch: string,
): ParkedRunCommits | undefined {
  return run?.parkedCommits
    ?.filter((entry) => entry.slotId === slotId && entry.branch === branch)
    .at(-1);
}

/**
 * A release that keeps an artifact-only run's checkout (COMPLETE, an interactive done-no-pr, a
 * failed run) records the head it leaves while the run still owns the slot, so a later ownerless
 * return to idle parks exactly that. Whether it parks is decided then, once the run has finished.
 */
export async function recordReleasedCheckout(
  run: Run,
  vars: SlotVars,
  exec: typeof execOnSlot,
): Promise<void> {
  if (!ownsArtifactOnlyBranch(run)) return;
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  const read = await exec(
    vars,
    `${git} symbolic-ref --quiet --short HEAD && ${git} rev-parse HEAD`,
  );
  const [branch, headSha] = read.stdout.trim().split('\n');
  if (read.exitCode !== 0 || branch !== run.branch || !headSha) return;
  const { persistRunNow, updateRun } = await import('../runs/store.js');
  await persistRunNow(
    updateRun(run.id, {
      releasedCheckout: { slotId: vars.slotId, branch, headSha, at: new Date().toISOString() },
    }),
    'artifact-only checkout released',
  );
}
