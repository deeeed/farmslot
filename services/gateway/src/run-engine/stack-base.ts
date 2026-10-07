// stack-base.ts — resolve where a stacked run sits before its task is written
// and its slot is prepared (ADR-040 stacked work).

import type { Run } from '@farmslot/protocol';

import { getProjectField, loadProjectVars } from '../core/config.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';
import { stackBaseForNode } from '../work-graph/store.js';

/**
 * Records `run.stack` once for a graph-linked dev/fix-bug run whose node stacks
 * on another node's published PR. Any other run is returned untouched, so its
 * task, branch and PR stay exactly as they were.
 */
export async function ensureRunStack(runId: string): Promise<Run> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (
    run.stack ||
    run.startRef ||
    !run.workGraphId ||
    !run.workNodeId ||
    (run.flowType !== 'dev' && run.flowType !== 'fix-bug')
  ) {
    return run;
  }
  const base = stackBaseForNode(run.workGraphId, run.workNodeId);
  if (!base) return run;
  const repo = await loadProjectVars(run.project)
    .then((projectVars) => getProjectField(projectVars.projectJson, 'ci.repo'))
    .catch(() => null);
  const updated = updateRun(runId, {
    stack: {
      ...base,
      ...(repo
        ? { upstreamPrUrl: `https://github.com/${repo}/pull/${base.upstreamPrNumber}` }
        : {}),
    },
  });
  await persistRunNow(updated, 'stack base');
  return updated;
}

/** The PR base a stacked run publishes against; undefined for every other run. */
export function stackPrBase(run: Pick<Run, 'stack'>): string | undefined {
  return run.stack ? (run.stack.retargetedTo ?? run.stack.baseBranch) : undefined;
}
