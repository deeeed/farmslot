// stack-retarget.ts — move a stacked run's PR onto the default branch once the
// PR it was stacked on has merged (ADR-040 stacked work).

import { DEFAULT_BRANCH, type Run } from '@farmslot/protocol';

import { getProjectField, loadProjectVars } from '../core/config.js';
import { ghRequest } from '../integrations/github-client.js';

const GH_TIMEOUT_MS = 60_000;

export interface StackRetargetResult {
  /** The base the run's PR targets from now on. */
  base: string;
  /** Ledger text describing what happened. */
  result: string;
}

/**
 * Retargets the run's open PR to the default branch, then merges that branch
 * into the PR head on GitHub. After a squash merge the head still carries the
 * upstream's original commits; the merge makes the PR diff show only this run's
 * work again. A conflict is left for the update-branch flow ci-watch dispatches.
 *
 * A run that has not published yet only needs the base: publication reads it
 * from `run.stack.retargetedTo`.
 */
export async function retargetStackedPr(run: Run): Promise<StackRetargetResult> {
  const projectVars = await loadProjectVars(run.project);
  const base = getProjectField(projectVars.projectJson, 'default_branch') || DEFAULT_BRANCH;
  if (!run.prNumber) return { base, result: `retargeted:before-publish->${base}` };
  if (run.prState === 'MERGED' || run.prState === 'CLOSED') {
    return { base, result: `skipped:#${run.prNumber} ${run.prState.toLowerCase()}` };
  }
  const repo = getProjectField(projectVars.projectJson, 'ci.repo');
  if (!repo) throw new Error(`Cannot retarget PR #${run.prNumber}: ${run.project} has no ci.repo`);
  const pr = String(run.prNumber);
  await ghRequest(['pr', 'edit', pr, '--repo', repo, '--base', base], {
    force: true,
    signal: AbortSignal.timeout(GH_TIMEOUT_MS),
  });
  try {
    await ghRequest(['pr', 'update-branch', pr, '--repo', repo], {
      force: true,
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/conflict/i.test(message)) throw err;
    return { base, result: `retargeted:#${pr}->${base}; update-branch conflict` };
  }
  return { base, result: `retargeted:#${pr}->${base}; updated from ${base}` };
}
