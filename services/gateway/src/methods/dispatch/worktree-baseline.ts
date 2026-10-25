import type { SlotVars } from '../../core/config.js';
import { execOnSlot } from '../../core/exec.js';
import { assertInheritedPrCommitsSigned } from '../../run-completion/commit-signatures.js';
import { getRun, persistRunNow, updateRun } from '../../runs/store.js';

/** Retained delivery bypasses dispatchExecute's pre-work Git baseline capture. */
export async function recordRetainedPrBaseline(runId: string, vars: SlotVars): Promise<void> {
  const run = getRun(runId);
  if (!run?.prNumber || run.worktreeHeadAtDispatch) return;
  const head = await execOnSlot(vars, 'git rev-parse HEAD', { timeout: 10_000 });
  if (head.exitCode !== 0 || !head.stdout.trim())
    throw new Error('Cannot capture the inherited PR head before retained task delivery');
  await assertInheritedPrCommitsSigned(run, vars, head.stdout.trim());
  await persistRunNow(
    updateRun(runId, { worktreeHeadAtDispatch: head.stdout.trim() }),
    'retained dispatch Git baseline',
  );
}
