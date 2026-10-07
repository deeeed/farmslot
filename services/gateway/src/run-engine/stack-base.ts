// stack-base.ts — resolve where a stacked run sits before its task is written
// and its slot is prepared (ADR-040 stacked work).

import type { Run } from '@farmslot/protocol';

import { getRun, persistRunNow, updateRun } from '../runs/store.js';
import { readUpstreamPr, type UpstreamPr } from '../work-graph/stack-retarget.js';
import { stackBaseForNode } from '../work-graph/store.js';

let upstreamPrReader: (project: string, prNumber: number) => Promise<UpstreamPr> = readUpstreamPr;

export function setUpstreamPrReaderForTests(
  fn: ((project: string, prNumber: number) => Promise<UpstreamPr>) | null,
): void {
  upstreamPrReader = fn ?? readUpstreamPr;
}

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
  // The graph knows what ci-watch last saw; GitHub says what the PR is now.
  const pr = await upstreamPrReader(run.project, base.upstreamPrNumber);
  if (pr.merged) return run;
  if (pr.state !== 'open') {
    throw new Error(
      `Stack base PR #${base.upstreamPrNumber} is closed; a stacked run starts only from an open PR`,
    );
  }
  if (!pr.sameRepo) {
    throw new Error(
      `Stack base PR #${base.upstreamPrNumber} comes from a fork; a stack shares one repository`,
    );
  }
  const updated = updateRun(runId, {
    stack: { ...base, baseBranch: pr.headRef, upstreamPrUrl: pr.url },
  });
  await persistRunNow(updated, 'stack base');
  return updated;
}

/** The PR base a stacked run publishes against; undefined for every other run. */
export function stackPrBase(run: Pick<Run, 'stack'>): string | undefined {
  return run.stack ? (run.stack.retargetedTo ?? run.stack.baseBranch) : undefined;
}

/**
 * The work graph a run belongs to for scheduling: its own, or for a follow-up
 * without graph links (pr-complete, ci-fix) the graph of the stacked run it
 * continues, so its completion can unblock that run's deferred update-branch.
 * Runs outside a stack get only their own link, exactly as before.
 */
export function scheduledGraphOf(
  run: Pick<Run, 'workGraphId' | 'parentRunId'>,
): string | undefined {
  if (run.workGraphId) return run.workGraphId;
  let parent = run.parentRunId ? getRun(run.parentRunId) : undefined;
  for (let hops = 0; parent && hops < 20; hops += 1) {
    if (parent.stack && parent.workGraphId) return parent.workGraphId;
    parent = parent.parentRunId ? getRun(parent.parentRunId) : undefined;
  }
  return undefined;
}
