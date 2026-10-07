// stack-retarget.ts — move a stacked run's PR onto the default branch once the
// PR it was stacked on has merged (ADR-040 stacked work).

import { DEFAULT_BRANCH, type Run } from '@farmslot/protocol';

import { getProjectField, loadProjectVars } from '../core/config.js';
import { ghRequest } from '../integrations/github-client.js';

/**
 * Retargets the run's open PR and returns the new base. A run that has not
 * published yet only needs the returned base: publication reads it from
 * `run.stack.retargetedTo`. Rebasing the branch stays with the existing
 * update-branch flow, which ci-watch dispatches when GitHub reports a conflict.
 */
export async function retargetStackedPr(run: Run): Promise<string> {
  const projectVars = await loadProjectVars(run.project);
  const base = getProjectField(projectVars.projectJson, 'default_branch') || DEFAULT_BRANCH;
  if (!run.prNumber || run.prState === 'MERGED' || run.prState === 'CLOSED') return base;
  const repo = getProjectField(projectVars.projectJson, 'ci.repo');
  if (!repo) throw new Error(`Cannot retarget PR #${run.prNumber}: ${run.project} has no ci.repo`);
  await ghRequest(['pr', 'edit', String(run.prNumber), '--repo', repo, '--base', base], {
    force: true,
  });
  return base;
}
