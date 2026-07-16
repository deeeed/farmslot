// run-engine/push-verification.ts — verify a worker's terminal "complete"
// signal is backed by a published branch before the run advances.
//
// Flows whose worker OWNS the push (pr-complete, update-branch) repeatedly
// signaled complete with committed-but-unpushed (or even uncommitted) work;
// the engine then evaluated a stale remote SHA in ci-watch and looped.
// Dev-style flows are exempt: their worker commits locally
// and the publication step performs the push.

import { resolveAgentTarget } from '../agents/contexts.js';
import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { normalizeRunner, sendRunnerInstructionSafely } from '../runners/registry.js';
import { getRun } from '../runs/store.js';

const WORKER_OWNED_PUSH_FLOWS = new Set(['pr-complete', 'update-branch']);
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

interface WorktreePublishState {
  dirtyFiles: number;
  unpushedCommits: number;
}

async function inspectWorktree(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  branch: string,
): Promise<WorktreePublishState> {
  // No pipes anywhere in these probes: a failing `git status` piped into
  // head/wc would exit 0 and falsely report a clean tree. Count client-side.
  const status = await execOnSlot(vars, 'git status --porcelain', {
    timeout: 30_000,
  });
  if (status.exitCode !== 0) {
    throw new Error(
      `push-verification git status failed (exit ${status.exitCode}): ${status.stderr || status.stdout}`,
    );
  }
  const dirtyFiles = status.stdout.split('\n').filter((line) => line.trim()).length;

  // The remote-tracking ref may be absent (skipPrepare, local-only branch): a
  // ref the worker never pushed IS unpushed work, not a probe error. Compare
  // against the explicit local branch ref, not HEAD — a worker that parks the
  // worktree on another ref must not hide unpushed commits on the PR branch.
  const remoteRef = `origin/${branch}`;
  const refProbe = await execOnSlot(
    vars,
    `git rev-parse --verify --quiet ${shellQuote(remoteRef)}`,
    { timeout: 30_000 },
  );
  // `--verify --quiet` exits 1 for a missing ref; anything else nonzero is a
  // genuine probe failure (timeout, not a repo) and must not silently take
  // the unpublished path.
  if (refProbe.exitCode !== 0 && refProbe.exitCode !== 1) {
    throw new Error(
      `push-verification rev-parse failed (exit ${refProbe.exitCode}): ${refProbe.stderr || refProbe.stdout}`,
    );
  }
  const hasRemoteRef = refProbe.exitCode === 0;
  if (!hasRemoteRef) {
    const localCommits = await execOnSlot(
      vars,
      `git rev-list --count ${shellQuote(`refs/heads/${branch}`)}`,
      { timeout: 30_000 },
    );
    if (localCommits.exitCode !== 0) {
      throw new Error(
        `push-verification rev-list failed for local ${branch} (exit ${localCommits.exitCode}): ${localCommits.stderr || localCommits.stdout}`,
      );
    }
    // No remote ref at all → the whole branch is unpublished.
    return { dirtyFiles, unpushedCommits: parseInt(localCommits.stdout.trim(), 10) || 1 };
  }

  const revList = await execOnSlot(
    vars,
    `git rev-list --count ${shellQuote(remoteRef)}..${shellQuote(`refs/heads/${branch}`)}`,
    { timeout: 30_000 },
  );
  if (revList.exitCode !== 0) {
    throw new Error(
      `push-verification rev-list failed (exit ${revList.exitCode}): ${revList.stderr || revList.stdout}`,
    );
  }
  return { dirtyFiles, unpushedCommits: parseInt(revList.stdout.trim(), 10) || 0 };
}

function describe(state: WorktreePublishState): string {
  const parts: string[] = [];
  if (state.dirtyFiles > 0) parts.push(`${state.dirtyFiles} uncommitted file(s)`);
  if (state.unpushedCommits > 0) parts.push(`${state.unpushedCommits} unpushed commit(s)`);
  return parts.join(' and ') || 'clean';
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
  if (!run || !branch || !WORKER_OWNED_PUSH_FLOWS.has(run.flowType)) {
    return { verified: true };
  }
  const vars = await loadSlotVars(slotId);
  let state = await inspectWorktree(vars, branch);
  if (state.dirtyFiles === 0 && state.unpushedCommits === 0) {
    return { verified: true, dirtyFiles: 0, unpushedCommits: 0 };
  }

  console.warn(
    `[push-verification] run ${runId.slice(0, 8)} — worker signaled complete but ${branch} has ${describe(state)}; sending publish nudge`,
  );

  let nudged = false;
  try {
    const target = await resolveAgentTarget(slotId, { runId, role: 'primary' });
    const instruction =
      `Your completion signal was received but the branch is not published. In ${vars.remoteRepo}: ` +
      `stage and commit the changes that belong to your task (leave any unrelated files alone) ` +
      `with a Conventional Commit message describing the fix, then publish the branch with: git push. ` +
      `Verify with git status before finishing.`;
    nudged = await sendRunnerInstructionSafely(
      vars,
      target.target,
      normalizeRunner(run.metrics.runner),
      instruction,
      'push-verification',
      undefined,
      { forceBusyPoll: true },
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
    if (state.dirtyFiles === 0 && state.unpushedCommits === 0) {
      console.log(
        `[push-verification] run ${runId.slice(0, 8)} — branch ${branch} published after nudge`,
      );
      return { verified: true, dirtyFiles: 0, unpushedCommits: 0, nudged };
    }
  }

  return {
    verified: false,
    reason: `worker signaled complete but ${branch} still has ${describe(state)} after publish nudge`,
    dirtyFiles: state.dirtyFiles,
    unpushedCommits: state.unpushedCommits,
    nudged,
  };
}
