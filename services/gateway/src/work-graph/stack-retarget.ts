// stack-retarget.ts — GitHub side of stacked runs (ADR-040 stacked work): read
// the upstream PR a run stacks on, move a stacked PR to the default branch once
// that upstream merged, then bring the default branch into its head.
//
// REST through `gh api` on purpose: it needs only repo scope.

import { DEFAULT_BRANCH, type Run } from '@farmslot/protocol';

import { getProjectField, loadProjectVars, loadSlotVars } from '../core/config.js';
import { ghRequest } from '../integrations/github-client.js';
import {
  completeBranchMaintenance,
  executeBranchMaintenance,
  MaintenanceRefusal,
  prepareBranchMaintenance,
  retireBranchMaintenance,
} from '../run-engine/branch-maintenance.js';

/** Whole-call deadline, including the wait for a gh concurrency slot. */
const GH_DEADLINE_MS = 90_000;

export interface StackRetargetResult {
  /** The base the run's PR targets from now on. */
  base: string;
  /** Ledger text describing what happened. */
  result: string;
  /** The upstream PR's merge commit on the default branch, when it merged. */
  upstreamMergeSha?: string;
}

export interface UpstreamPr {
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  /** False when the head lives in a fork: a stack shares one repository. */
  sameRepo: boolean;
  url: string;
  mergeSha?: string;
  mergedAt?: string;
}

async function withDeadline<T>(operation: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${GH_DEADLINE_MS / 1000}s`)),
      GH_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function projectGitHub(project: string): Promise<{ repo: string; base: string }> {
  const projectVars = await loadProjectVars(project);
  const repo = getProjectField(projectVars.projectJson, 'ci.repo');
  if (!repo) throw new Error(`${project} has no ci.repo; stacked runs need the PR's repository`);
  const base = getProjectField(projectVars.projectJson, 'default_branch') || DEFAULT_BRANCH;
  return { repo, base };
}

function ghApi(args: string[], what: string) {
  return withDeadline(
    ghRequest(['api', ...args], { force: true, signal: AbortSignal.timeout(GH_DEADLINE_MS) }),
    what,
  );
}

/** The upstream PR as GitHub reports it now. */
export async function readUpstreamPr(project: string, prNumber: number): Promise<UpstreamPr> {
  const { repo } = await projectGitHub(project);
  const output = await ghApi([`repos/${repo}/pulls/${prNumber}`], `reading PR #${prNumber}`);
  const pr = JSON.parse(output.stdout) as {
    state: 'open' | 'closed';
    merged?: boolean;
    merged_at?: string | null;
    merge_commit_sha?: string | null;
    html_url: string;
    head: { ref: string; repo?: { full_name?: string } | null };
  };
  return {
    state: pr.state,
    merged: pr.merged === true,
    headRef: pr.head.ref,
    sameRepo: pr.head.repo?.full_name?.toLowerCase() === repo.toLowerCase(),
    url: pr.html_url,
    ...(pr.merged && pr.merge_commit_sha ? { mergeSha: pr.merge_commit_sha } : {}),
    ...(pr.merged && pr.merged_at ? { mergedAt: pr.merged_at } : {}),
  };
}

/**
 * Moves the run's open PR to the default branch. A run that has not published
 * yet only needs the returned base: publication reads `run.stack.retargetedTo`.
 */
export async function retargetStackedPr(run: Run): Promise<StackRetargetResult> {
  const { repo, base } = await projectGitHub(run.project);
  // The merge commit tells a later diff whether a checkout has taken the upstream in.
  const upstreamMergeSha = run.stack
    ? (await readUpstreamPr(run.project, run.stack.upstreamPrNumber)).mergeSha
    : undefined;
  const merge = upstreamMergeSha ? { upstreamMergeSha } : {};
  if (!run.prNumber) return { base, result: `retargeted:before-publish->${base}`, ...merge };
  if (run.prState === 'MERGED' || run.prState === 'CLOSED') {
    return { base, result: `skipped:#${run.prNumber} ${run.prState.toLowerCase()}`, ...merge };
  }
  await ghApi(
    ['-X', 'PATCH', `repos/${repo}/pulls/${run.prNumber}`, '-f', `base=${base}`],
    `retargeting PR #${run.prNumber}`,
  );
  return { base, result: `retargeted:#${run.prNumber}->${base}`, ...merge };
}

/**
 * Merges the default branch into a retargeted PR's head. After a squash merge
 * the head still carries the upstream's original commits; this makes the PR
 * diff show only the stacked run's work. Called only once nothing in the run's
 * family is active, so no warm worker holds a local branch that would diverge.
 * A conflict is left to the update-branch flow ci-watch dispatches.
 */
interface StackUpdateDependencies {
  project: typeof projectGitHub;
  loadSlot: typeof loadSlotVars;
  prepare: typeof prepareBranchMaintenance;
  complete: typeof completeBranchMaintenance;
  execute: typeof executeBranchMaintenance;
  retire: typeof retireBranchMaintenance;
}

export async function updateStackedPrBranch(
  run: Run,
  deps: StackUpdateDependencies = {
    project: projectGitHub,
    loadSlot: loadSlotVars,
    prepare: prepareBranchMaintenance,
    complete: completeBranchMaintenance,
    execute: executeBranchMaintenance,
    retire: retireBranchMaintenance,
  },
): Promise<StackRetargetResult> {
  const { base } = await deps.project(run.project);
  if (!run.prNumber) return { base, result: 'update-branch:no-pr' };
  if (!run.slotId)
    throw new Error('Stack catch-up has no retained slot for provenance verification');
  const vars = await deps.loadSlot(run.slotId);
  const operation = await deps.prepare(run, vars, base, 'graph-merge');
  if (!operation) throw new MaintenanceRefusal('PARENT_BOUNDARY_MISSING');
  try {
    // The SDK pins both ordered parents and the clean merge tree. Its durable
    // receipt reconciles a push interrupted before checkpoint renewal.
    await deps.execute(vars, operation);
    await deps.complete(run, operation);
  } catch (error) {
    if (
      error instanceof MaintenanceRefusal &&
      ['GRAPH_MERGE_CONFLICT', 'TARGET_CHANGED', 'REMOTE_CHILD_CHANGED'].includes(error.code)
    ) {
      await deps.retire(run, operation);
      if (error.code === 'GRAPH_MERGE_CONFLICT')
        return { base, result: `update-branch:#${run.prNumber} conflict` };
    }
    throw error;
  }
  return { base, result: `update-branch:#${run.prNumber} merged ${base}` };
}
