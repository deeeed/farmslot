import timers from 'node:timers/promises';

import { GIT_DIFF_COMMAND } from '@farmslot/agent-runtime/scripts/git-diff.cjs';
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

import { resolveAgentTarget, selectAgentContext } from '../agents/contexts.js';
import { loadSlotVars } from '../core/config.js';
import { EXEC_TIMEOUT_EXIT_CODE, execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { assertRunCommitSignatures } from '../run-completion/commit-signatures.js';
import { normalizeRunner, sendRunnerInstructionSafely } from '../runners/registry.js';
import {
  resolveRunRetainedSessionBinding,
  retainedSessionSendOption,
} from '../runners/session-process.js';
import { getRun } from '../runs/store.js';

const WORKER_OWNED_PUSH_FLOWS = new Set(['pr-complete', 'update-branch']);
// Dev workers commit locally and the publication step performs the push, so a push
// cannot be required at completion. Uncommitted work is a different matter: it
// exists only in the slot worktree and is destroyed when the slot is reclaimed.
// Run 32909fa2 completed with 26 files uncommitted and no commits on its branch.
const WORKER_OWNED_COMMIT_FLOWS = new Set(['dev']);
const PUSH_RECHECK_INTERVAL_MS = 20_000;
const PUSH_NUDGE_WAIT_MS = 5 * 60_000;
// First wait before re-running an inspection that timed out; doubles per retry.
const INSPECTION_RETRY_BACKOFF_MS = 5_000;

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
   * Dirty paths: tracked content changes, plus untracked paths in push mode,
   * whose gate requires a fully clean tree.
   */
  dirtyFiles: number;
  /** Modified/deleted/staged tracked paths (content vs HEAD). */
  trackedDirtyFiles: number;
  /**
   * Untracked (non-ignored) paths, walked in push mode only. Often farm
   * leftovers (e.g. AgenticService scaffold) rather than task work the worker
   * just committed. Commit-mode completion does not treat these as blocking —
   * the nudge also tells the worker to leave unrelated files alone, so counting
   * them would soft-lock — so it does not walk them at all.
   */
  untrackedFiles?: number;
  unpushedCommits: number;
}

type GitExecutor = (command: string) => Promise<ExecResult>;

/**
 * The whole inspection as one shell script (bash, or zsh on macOS nodes).
 * It prints NUL-terminated records: the tracked-content and staged path lists,
 * then the untracked list in push mode, each closed by an empty record (no path
 * is empty); then the comparison: `remote` or `base` with a commit count, or
 * `none`. A failing probe prints its name as the last record and exits with its
 * status.
 */
function inspectionScript(branch: string, mode: 'push' | 'commit'): string {
  const remoteRef = `origin/${branch}`;
  return [
    `b=${shellQuote(`refs/heads/${branch}`)}`,
    `fail() { printf '\\0%s\\0' "$2"; exit "$1"; }`,
    // rev-parse --verify --quiet exits 1 for a missing ref; above 1 is a git error.
    `exists() { git rev-parse --verify --quiet "$1" >/dev/null; rc=$?; [ "$rc" -le 1 ] || fail "$rc" "$2"; return "$rc"; }`,
    `ahead() { n=$(git rev-list --count "$2..$b") || fail $? "rev-list $2..$b"; printf '%s\\0%s\\0' "$1" "$n"; exit 0; }`,
    // `git status` can report a tracked path as modified from stale stat data
    // even when its content is unchanged, so diff tracked content against HEAD.
    `if exists HEAD 'HEAD probe'; then`,
    `  ${GIT_DIFF_COMMAND} --name-only -z HEAD -- || fail $? 'tracked-content diff'; printf '\\0'`,
    `  ${GIT_DIFF_COMMAND} --cached --name-only -z HEAD -- || fail $? 'staged-content diff'; printf '\\0'`,
    `else`,
    `  git ls-files --cached -z || fail $? 'tracked-content diff'; printf '\\0\\0'`,
    `fi`,
    ...(mode === 'push'
      ? [
          `git ls-files --others --exclude-standard -z || fail $? 'untracked-files probe'; printf '\\0'`,
        ]
      : []),
    `exists ${shellQuote(remoteRef)} ${shellQuote(`rev-parse ${remoteRef}`)} && ahead remote ${shellQuote(remoteRef)}`,
    // A new local branch has no origin/<branch> yet. Compare it with its
    // configured upstream when present, otherwise origin/HEAD.
    `u=$(git for-each-ref --format='%(upstream:short)' "$b") || fail $? ${shellQuote(`upstream probe for ${branch}`)}`,
    `[ -n "$u" ] && exists "$u" "rev-parse $u" && ahead base "$u"`,
    `o=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD); rc=$?`,
    `[ "$rc" -le 1 ] || fail "$rc" 'origin/HEAD probe'`,
    `[ -n "$o" ] && ahead base "$o"`,
    `printf 'none\\0'`,
  ].join('\n');
}

/**
 * Inspect content dirtiness and unpublished commits in one slot exec, using an
 * injectable executor so tests can run the script against real repositories.
 * Each probe used to be its own remote exec: six to nine per inspection.
 */
export async function inspectWorktreePublishState(
  branch: string,
  mode: 'push' | 'commit',
  execute: GitExecutor,
): Promise<WorktreePublishState> {
  const result = await execute(inspectionScript(branch, mode));
  const records = result.stdout.split('\0');
  if (result.exitCode !== 0) {
    // An exec that timed out was killed before any probe could name itself.
    const probe =
      (result.exitCode !== EXEC_TIMEOUT_EXIT_CODE && records.at(-2)) || 'worktree inspection';
    throw new Error(
      `push-verification ${probe} failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }
  let at = 0;
  const paths = () => {
    const start = at;
    while (records[at]) at++;
    return records.slice(start, at++);
  };
  const tracked = new Set([...paths(), ...paths()]);
  const untracked = mode === 'push' ? paths() : undefined;
  const [comparison, ahead] = records.slice(at);
  const commits = parseInt(ahead ?? '', 10) || 0;
  return {
    dirtyFiles: new Set([...tracked, ...(untracked ?? [])]).size,
    trackedDirtyFiles: tracked.size,
    ...(untracked ? { untrackedFiles: untracked.length } : {}),
    // Against an upstream or origin/HEAD, counting the entire local branch
    // history produced absurd values (for example 31,508 "unpushed commits")
    // and obscured the actual one-commit state. With neither a feature remote
    // nor a trustworthy base ref, publication cannot be proven: report the safe
    // minimum and keep the gate closed.
    unpushedCommits: comparison === 'remote' ? commits : Math.max(1, commits),
  };
}

/**
 * Inspect the worktree, retrying an inspection that only ran out of time.
 * Run e4d0cc24 finished its task and then failed here: its slot host was
 * briefly overloaded and the untracked-files probe hit the 30 s exec timeout;
 * the same probe answered in under a second later. A git error still throws at
 * once. A timeout backs off and retries until `deadline`, then throws. Returns
 * 'aborted' once `signal` fires, so the cancel path keeps the run status.
 */
export async function inspectWorktreeWithRetry(
  branch: string,
  mode: 'push' | 'commit',
  execute: GitExecutor,
  deadline: number,
  signal?: AbortSignal,
): Promise<WorktreePublishState | 'aborted'> {
  let exitCode = 0;
  const probe: GitExecutor = async (command) => {
    const result = await execute(command);
    exitCode = result.exitCode;
    return result;
  };
  for (let backoff = INSPECTION_RETRY_BACKOFF_MS; ; backoff *= 2) {
    try {
      return await inspectWorktreePublishState(branch, mode, probe);
    } catch (err) {
      // Never let a probe error racing a cancellation escape as a step failure
      // that overwrites the cancel status.
      if (signal?.aborted) return 'aborted';
      if (exitCode !== EXEC_TIMEOUT_EXIT_CODE || Date.now() + backoff >= deadline) throw err;
    }
    await timers.setTimeout(backoff, undefined, { signal }).catch(() => undefined);
    if (signal?.aborted) return 'aborted';
  }
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
    // Commit-mode only blocks on (and only inspects) tracked dirtiness.
    if (state.trackedDirtyFiles > 0) {
      parts.push(`${state.trackedDirtyFiles} uncommitted tracked file(s)`);
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

export function stateSatisfiesMode(state: WorktreePublishState, mode: 'push' | 'commit'): boolean {
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
 * inspection failures and unsigned commits DO throw, naming the commits to repair.
 */
export async function verifyWorkerPushedBranch(
  runId: string,
  slotId: string,
  signal?: AbortSignal,
): Promise<PushVerificationResult> {
  const run = getRun(runId);
  const branch = run?.branch;
  if (run) await assertRunCommitSignatures(run);
  const mode = run ? completionVerificationMode(run) : 'none';
  if (!run || !branch || mode === 'none') {
    return { verified: true };
  }
  if (mode !== 'push' && mode !== 'commit') {
    return { verified: true };
  }
  const vars = await loadSlotVars(slotId);
  const execute: GitExecutor = (command) => execOnSlot(vars, command, { timeout: 30_000, signal });
  // The worker has finished: a slow first inspection gets the same bounded wait
  // a publish nudge gets before the run fails on it.
  let state = await inspectWorktreeWithRetry(
    branch,
    mode,
    execute,
    Date.now() + PUSH_NUDGE_WAIT_MS,
    signal,
  );
  if (state === 'aborted') {
    return { verified: false, aborted: true, reason: 'verification aborted (run cancelled)' };
  }
  if (stateSatisfiesMode(state, mode)) {
    return { verified: true, dirtyFiles: state.dirtyFiles, unpushedCommits: state.unpushedCommits };
  }

  console.warn(
    `[push-verification] run ${runId.slice(0, 8)} — worker signaled complete but ${branch} has ${describe(state, mode)}; sending publish nudge`,
  );

  let nudged = false;
  try {
    const target = await resolveAgentTarget(slotId, { runId, role: 'primary' });
    const primaryContext = selectAgentContext(run, { role: 'primary' });
    const retainedSession = resolveRunRetainedSessionBinding(run, primaryContext);
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
      {
        forceBusyPoll: true,
        recovery: { runId },
        ...retainedSessionSendOption(retainedSession),
      },
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
    // Re-check after the sleep too.
    if (signal?.aborted) {
      return { verified: false, aborted: true, reason: 'verification aborted (run cancelled)' };
    }
    const next = await inspectWorktreeWithRetry(branch, mode, execute, deadline, signal);
    if (next === 'aborted') {
      return { verified: false, aborted: true, reason: 'verification aborted (run cancelled)' };
    }
    state = next;
    if (stateSatisfiesMode(state, mode)) {
      await assertRunCommitSignatures(getRun(runId) ?? run);
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
