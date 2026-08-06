// run-engine/push-verification.ts — verify a worker's terminal "complete"
// signal is backed by a published branch before the run advances.
//
// Flows whose worker OWNS the push (pr-complete, update-branch) repeatedly
// signaled complete with committed-but-unpushed (or even uncommitted) work;
// the engine then evaluated a stale remote SHA in ci-watch and looped.
//
// Dev flows are not push-verified — their worker commits locally and the
// publication step performs the push, so requiring a push here would fire before
// the push is meant to happen. They ARE commit-verified: uncommitted work exists
// only in the slot worktree and is destroyed when the slot is reclaimed, which is
// a different failure from an unpushed commit and needs its own check.

import { type ExecResult, isInteractiveDevRun, type Run } from '@farmslot/protocol';

import { resolveAgentTarget } from '../agents/contexts.js';
import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { normalizeRunner, sendRunnerInstructionSafely } from '../runners/registry.js';
import { getRun } from '../runs/store.js';

const WORKER_OWNED_PUSH_FLOWS = new Set(['pr-complete', 'update-branch']);
// Dev workers commit locally and the publication step performs the push, so a push
// cannot be required at completion. Uncommitted work is a different matter: it
// exists only in the slot worktree and is destroyed when the slot is reclaimed.
// Run 32909fa2 completed with 26 files uncommitted and no commits on its branch.
const WORKER_OWNED_COMMIT_FLOWS = new Set(['dev']);
const PUSH_RECHECK_INTERVAL_MS = 20_000;
const PUSH_NUDGE_WAIT_MS = 5 * 60_000;

export interface PushVerificationResult {
  verified: boolean;
  /** Human-readable state when unverified. */
  reason?: string;
  dirtyFiles?: number;
  unpushedCommits?: number;
  nudged?: boolean;
  /** True when the run was cancelled mid-verification — callers must not block the run. */
  aborted?: boolean;
}

export interface WorktreePublishState {
  /**
   * Total dirty paths (tracked content changes + untracked). Kept for
   * diagnostics and push-mode gates that require a fully clean tree.
   */
  dirtyFiles: number;
  /** Modified/deleted/staged tracked paths (content vs HEAD). */
  trackedDirtyFiles: number;
  /**
   * Untracked (non-ignored) paths. Often farm leftovers (e.g. AgenticService
   * scaffold) rather than task work the worker just committed. Commit-mode
   * completion does not treat these as blocking — the nudge also tells the
   * worker to leave unrelated files alone, so counting them would soft-lock.
   */
  untrackedFiles: number;
  unpushedCommits: number;
}

type GitExecutor = (command: string) => Promise<ExecResult>;

function assertGitProbe(result: ExecResult, probe: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `push-verification ${probe} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
}

function refExists(result: ExecResult, probe: string): boolean {
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  assertGitProbe(result, probe);
  return false;
}

function nulPaths(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean);
}

async function countCommitsAhead(
  execute: GitExecutor,
  baseRef: string,
  branchRef: string,
): Promise<number> {
  const result = await execute(
    `git rev-list --count ${shellQuote(baseRef)}..${shellQuote(branchRef)}`,
  );
  assertGitProbe(result, `rev-list ${baseRef}..${branchRef}`);
  return parseInt(result.stdout.trim(), 10) || 0;
}

/**
 * Inspect content dirtiness and unpublished commits using an injectable git
 * executor so the branch/ref fallback behavior is deterministic in tests.
 */
export async function inspectWorktreePublishState(
  branch: string,
  execute: GitExecutor,
): Promise<WorktreePublishState> {
  // `git status` can report a tracked path as modified from stale stat data
  // even when its content is unchanged. Diff tracked content against HEAD and
  // collect untracked files separately; NUL delimiters preserve unusual paths.
  const headProbe = await execute('git rev-parse --verify --quiet HEAD');
  const hasHead = refExists(headProbe, 'HEAD probe');
  const worktree = await execute(
    hasHead ? 'git diff --name-only -z HEAD --' : 'git ls-files --cached -z',
  );
  assertGitProbe(worktree, 'tracked-content diff');
  const staged = hasHead
    ? await execute('git diff --cached --name-only -z HEAD --')
    : { stdout: '', stderr: '', exitCode: 0 };
  assertGitProbe(staged, 'staged-content diff');
  const untracked = await execute('git ls-files --others --exclude-standard -z');
  assertGitProbe(untracked, 'untracked-files probe');
  const trackedDirtyFiles = new Set([...nulPaths(worktree.stdout), ...nulPaths(staged.stdout)])
    .size;
  const untrackedFiles = nulPaths(untracked.stdout).length;
  const dirtyFiles = new Set([
    ...nulPaths(worktree.stdout),
    ...nulPaths(staged.stdout),
    ...nulPaths(untracked.stdout),
  ]).size;
  const baseState = { dirtyFiles, trackedDirtyFiles, untrackedFiles };

  const branchRef = `refs/heads/${branch}`;
  const remoteRef = `origin/${branch}`;
  const remoteProbe = await execute(`git rev-parse --verify --quiet ${shellQuote(remoteRef)}`);
  if (refExists(remoteProbe, `rev-parse ${remoteRef}`)) {
    return {
      ...baseState,
      unpushedCommits: await countCommitsAhead(execute, remoteRef, branchRef),
    };
  }

  // A new local branch has no origin/<branch> yet. Compare it with its
  // configured upstream when present, otherwise origin/HEAD. Counting the
  // entire local branch history here produced absurd values (for example
  // 31,508 "unpushed commits") and obscured the actual one-commit state.
  const upstreamResult = await execute(
    `git for-each-ref --format=${shellQuote('%(upstream:short)')} ${shellQuote(branchRef)}`,
  );
  assertGitProbe(upstreamResult, `upstream probe for ${branch}`);
  const upstreamRef = upstreamResult.stdout.trim();
  if (upstreamRef) {
    const upstreamProbe = await execute(
      `git rev-parse --verify --quiet ${shellQuote(upstreamRef)}`,
    );
    if (refExists(upstreamProbe, `rev-parse ${upstreamRef}`)) {
      return {
        ...baseState,
        unpushedCommits: Math.max(1, await countCommitsAhead(execute, upstreamRef, branchRef)),
      };
    }
  }

  const originHead = await execute('git symbolic-ref --quiet --short refs/remotes/origin/HEAD');
  const originHeadRef = originHead.stdout.trim();
  if (refExists(originHead, 'origin/HEAD probe') && originHeadRef) {
    return {
      ...baseState,
      unpushedCommits: Math.max(1, await countCommitsAhead(execute, originHeadRef, branchRef)),
    };
  }

  // With neither a feature remote nor a trustworthy base ref, publication
  // cannot be proven. Report the safe minimum instead of the whole repository
  // history and keep the gate closed.
  return { ...baseState, unpushedCommits: 1 };
}

async function inspectWorktree(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  branch: string,
): Promise<WorktreePublishState> {
  return inspectWorktreePublishState(branch, (command) =>
    execOnSlot(vars, command, { timeout: 30_000 }),
  );
}

/**
 * What must hold before a worker's terminal signal is accepted.
 *
 * - `push`   — the worker owns publication; committed AND pushed.
 * - `commit` — the worker commits and a later step publishes; committed only.
 *              Requiring a push here would fire before the push is meant to happen.
 * - `none`   — not the worker's to guarantee. Interactive dev is operator-owned:
 *              the operator decides whether work is saved at all, and the template
 *              tells the worker to keep changes local. Its completion is guarded in
 *              the monitor step instead.
 */
export function completionVerificationMode(run: Run): 'push' | 'commit' | 'none' {
  if (WORKER_OWNED_PUSH_FLOWS.has(run.flowType)) return 'push';
  if (!WORKER_OWNED_COMMIT_FLOWS.has(run.flowType)) return 'none';
  return isInteractiveDevRun(run) ? 'none' : 'commit';
}

function describe(state: WorktreePublishState, mode: 'push' | 'commit' | 'none' = 'push'): string {
  const parts: string[] = [];
  if (mode === 'commit') {
    // Commit-mode only blocks on tracked dirtiness; still surface untracked for operators.
    if (state.trackedDirtyFiles > 0) {
      parts.push(`${state.trackedDirtyFiles} uncommitted tracked file(s)`);
    }
    if (state.untrackedFiles > 0) {
      parts.push(
        `${state.untrackedFiles} untracked leftover file(s) (non-blocking for commit-mode)`,
      );
    }
  } else if (state.dirtyFiles > 0) {
    parts.push(`${state.dirtyFiles} uncommitted file(s)`);
  }
  if (mode === 'push' && state.unpushedCommits > 0) {
    parts.push(`${state.unpushedCommits} unpushed commit(s)`);
  } else if (mode === 'commit' && state.unpushedCommits > 0) {
    // Push is owned by the publication step for dev flows — do not present as a failure.
  }
  return parts.join(' and ') || 'clean';
}

function stateSatisfiesMode(state: WorktreePublishState, mode: 'push' | 'commit'): boolean {
  if (mode === 'commit') {
    // Autonomous dev: worker must commit task work. Publication pushes later.
    // Untracked farm leftovers must not soft-lock after a clean task commit
    // (run add136c6: AgenticService leftovers + nudge "leave unrelated alone").
    return state.trackedDirtyFiles === 0;
  }
  return state.dirtyFiles === 0 && state.unpushedCommits === 0;
}

/**
 * Verify the slot worktree is committed and pushed for worker-owned-push
 * flows. When it is not, deliver ONE publish nudge to the worker session and
 * wait bounded time for the push to land. Returns verified=false (never
 * throws for unpushed state) so the caller decides how to surface it; git
 * inspection failures DO throw — a broken probe must not pass as verified.
 */
export async function verifyWorkerPushedBranch(
  runId: string,
  slotId: string,
  signal?: AbortSignal,
): Promise<PushVerificationResult> {
  const run = getRun(runId);
  const branch = run?.branch;
  const mode = run ? completionVerificationMode(run) : 'none';
  if (!run || !branch || mode === 'none') {
    return { verified: true };
  }
  if (mode !== 'push' && mode !== 'commit') {
    return { verified: true };
  }
  const vars = await loadSlotVars(slotId);
  let state = await inspectWorktree(vars, branch);
  if (stateSatisfiesMode(state, mode)) {
    return { verified: true, dirtyFiles: state.dirtyFiles, unpushedCommits: state.unpushedCommits };
  }

  console.warn(
    `[push-verification] run ${runId.slice(0, 8)} — worker signaled complete but ${branch} has ${describe(state, mode)}; sending publish nudge`,
  );

  let nudged = false;
  try {
    const target = await resolveAgentTarget(slotId, { runId, role: 'primary' });
    const instruction =
      mode === 'push'
        ? `Your completion signal was received but the branch is not published. In ${vars.remoteRepo}: ` +
          `stage and commit the changes that belong to your task (leave any unrelated files alone) ` +
          `with a Conventional Commit message describing the fix, then publish the branch with: git push. ` +
          `Verify with git status before finishing.`
        : `Your completion signal was received but ${vars.remoteRepo} still has uncommitted tracked changes. ` +
          `Work left uncommitted lives only in this slot and is destroyed when the slot is reclaimed. ` +
          `Stage and commit the tracked changes that belong to your task (leave unrelated untracked leftovers alone) ` +
          `with a Conventional Commit message. Pushing is not required here. ` +
          `Verify with git status before finishing.`;
    nudged = await sendRunnerInstructionSafely(
      vars,
      target.target,
      normalizeRunner(run.metrics.runner),
      instruction,
      'push-verification',
      undefined,
      // ADR-032 Phase 3A: persist a hook-only degraded hold through the ADR-031 audit.
      { forceBusyPoll: true, recovery: { runId } },
    );
    console.log(
      `[push-verification] run ${runId.slice(0, 8)} — publish nudge ${nudged ? 'delivered' : 'NOT delivered (send deferred/failed)'}`,
    );
  } catch (err) {
    // Target resolution can fail when the worker session is gone (relaunch
    // left a bare shell); the bounded wait below still gives a mid-push
    // worker time to land, then we surface unverified loudly.
    console.warn(
      `[push-verification] run ${runId.slice(0, 8)} — publish nudge failed: ${(err as Error).message}`,
    );
  }

  const deadline = Date.now() + PUSH_NUDGE_WAIT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return { verified: false, aborted: true, reason: 'verification aborted (run cancelled)' };
    }
    await new Promise((resolve) => setTimeout(resolve, PUSH_RECHECK_INTERVAL_MS));
    // Re-check after the sleep too, and never let a probe error racing a
    // cancellation escape as a step failure that overwrites the cancel status.
    if (signal?.aborted) {
      return { verified: false, aborted: true, reason: 'verification aborted (run cancelled)' };
    }
    try {
      state = await inspectWorktree(vars, branch);
    } catch (err) {
      if (signal?.aborted) {
        return { verified: false, aborted: true, reason: 'verification aborted (run cancelled)' };
      }
      throw err;
    }
    if (stateSatisfiesMode(state, mode)) {
      console.log(
        `[push-verification] run ${runId.slice(0, 8)} — branch ${branch} ` +
          `${mode === 'push' ? 'published' : 'committed'} after nudge`,
      );
      // Report what was actually observed. In commit mode unpushed commits are
      // expected and left for the publication step, so claiming zero would be false.
      return {
        verified: true,
        dirtyFiles: state.dirtyFiles,
        unpushedCommits: state.unpushedCommits,
        nudged,
      };
    }
  }

  return {
    verified: false,
    reason: `worker signaled complete but ${branch} still has ${describe(state, mode)} after publish nudge`,
    dirtyFiles: state.dirtyFiles,
    unpushedCommits: state.unpushedCommits,
    nudged,
  };
}
