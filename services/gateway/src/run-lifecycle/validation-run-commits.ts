import type { Run } from '@farmslot/protocol';
import { isRecord } from '@farmslot/protocol/recipe';

import { shellQuote } from '../core/tmux.js';

/** Lazy, like the rest of slot recovery: release paths load before the slot I/O modules. */
async function slotGit(slotId: string) {
  const [{ loadSlotVars }, { execOnSlot }] = await Promise.all([
    import('../core/config.js'),
    import('../core/exec.js'),
  ]);
  const vars = await loadSlotVars(slotId);
  return { vars, execOnSlot, git: `git -C ${shellQuote(vars.remoteRepo)}` };
}

/** A validation run's own commits, parked under a durable ref when its slot returned to idle. */
export interface ParkedValidationCommits {
  slotId: string;
  ref: string;
  branch: string;
  baseSha: string;
  headSha: string;
  commits: string[];
  parkedAt: string;
}

/**
 * An artifact-only dev or fix-bug run never pushes or publishes: its branch commits are its
 * retained output, not anyone's unpublished work. Left on the slot they block the next dispatch
 * (the picker and prepare both refuse unpushed commits), so they are parked instead.
 */
export function isValidationRun(run: Run): boolean {
  return run.completionPolicy === 'artifact-only' && ['dev', 'fix-bug'].includes(run.flowType);
}

export function parkedValidationCommits(run: Run): ParkedValidationCommits | undefined {
  const value = run.steps.find((step) => step.name === 'prepare')?.outputs?.parkedValidationCommits;
  if (!isRecord(value)) return undefined;
  const { slotId, ref, branch, baseSha, headSha, commits, parkedAt } = value;
  return typeof slotId === 'string' &&
    typeof ref === 'string' &&
    typeof branch === 'string' &&
    typeof baseSha === 'string' &&
    typeof headSha === 'string' &&
    Array.isArray(commits) &&
    commits.every((commit) => typeof commit === 'string') &&
    typeof parkedAt === 'string'
    ? { slotId, ref, branch, baseSha, headSha, commits, parkedAt }
    : undefined;
}

/**
 * Park the checkout's commits when they are exactly this validation run's own: the checkout is
 * on the run's branch and descends from its dispatch baseline. The head is kept reachable at
 * `refs/farmslot/parked/<runId>` and every commit SHA is recorded on the run before the slot is
 * reset. Returns null, parking nothing, for any other checkout.
 */
export async function parkValidationRunCommits(
  run: Run,
  slotId: string,
  checkout: { branch: string; headSha: string },
): Promise<ParkedValidationCommits | null> {
  const baseSha = run.startRef?.resolvedSha ?? run.worktreeHeadAtDispatch;
  if (!isValidationRun(run) || !run.branch || checkout.branch !== run.branch || !baseSha)
    return null;
  const { vars, execOnSlot: exec, git } = await slotGit(slotId);
  const own = await exec(
    vars,
    `${git} merge-base --is-ancestor ${shellQuote(baseSha)} ${shellQuote(checkout.headSha)}`,
  );
  if (own.exitCode !== 0) return null;
  const listed = await exec(
    vars,
    `${git} rev-list ${shellQuote(`${baseSha}..${checkout.headSha}`)}`,
  );
  if (listed.exitCode !== 0) return null;
  const ref = `refs/farmslot/parked/${run.id}`;
  const parked = await exec(
    vars,
    `${git} update-ref ${shellQuote(ref)} ${shellQuote(checkout.headSha)}`,
  );
  if (parked.exitCode !== 0)
    throw new Error(`Cannot park ${run.branch} on ${slotId}: ${parked.stderr || parked.stdout}`);
  const record: ParkedValidationCommits = {
    slotId,
    ref,
    branch: run.branch,
    baseSha,
    headSha: checkout.headSha,
    commits: listed.stdout.split('\n').filter(Boolean),
    parkedAt: new Date().toISOString(),
  };
  const { getRun, persistRunNow, updateRunStep } = await import('../runs/store.js');
  const step = run.steps.find((candidate) => candidate.name === 'prepare');
  if (step) {
    updateRunStep(run.id, 'prepare', {
      outputs: { ...step.outputs, parkedValidationCommits: record },
    });
    await persistRunNow(getRun(run.id)!, 'validation commits parked');
  }
  console.log(
    `[slot.release] ${slotId}: parked validation run ${run.id.slice(0, 8)}'s ${record.commits.length} commit(s) on ${run.branch} at ${ref} (${checkout.headSha.slice(0, 12)})`,
  );
  return record;
}

/**
 * After the slot returned to its default branch, drop the parked run's branch so a later dispatch
 * of the same ticket can prepare it again. Only an unchanged branch is deleted; its commits stay
 * reachable from the parked ref.
 */
export async function dropParkedValidationBranch(parked: ParkedValidationCommits): Promise<void> {
  const { vars, execOnSlot: exec, git } = await slotGit(parked.slotId);
  const dropped = await exec(
    vars,
    `${git} update-ref -d ${shellQuote(`refs/heads/${parked.branch}`)} ${shellQuote(parked.headSha)}`,
  );
  if (dropped.exitCode !== 0)
    console.warn(
      `[slot.release] ${parked.slotId}: kept branch ${parked.branch} (it moved or is checked out): ${dropped.stderr || dropped.stdout}`,
    );
}
