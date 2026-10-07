// stack-retarget.ts — GitHub side of stacked runs (ADR-040 stacked work): read
// the upstream PR a run stacks on, move a stacked PR to the default branch once
// that upstream merged, then bring the default branch into its head.
//
// REST through `gh api` on purpose: it needs only repo scope.

import { DEFAULT_BRANCH, type Run } from '@farmslot/protocol';

import { getProjectField, loadProjectVars } from '../core/config.js';
import { ghRequest } from '../integrations/github-client.js';

/** Whole-call deadline, including the wait for a gh concurrency slot. */
const GH_DEADLINE_MS = 90_000;

export interface StackRetargetResult {
  /** The base the run's PR targets from now on. */
  base: string;
  /** Ledger text describing what happened. */
  result: string;
}

export interface UpstreamPr {
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  /** False when the head lives in a fork: a stack shares one repository. */
  sameRepo: boolean;
  url: string;
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
    html_url: string;
    head: { ref: string; repo?: { full_name?: string } | null };
  };
  return {
    state: pr.state,
    merged: pr.merged === true,
    headRef: pr.head.ref,
    sameRepo: pr.head.repo?.full_name?.toLowerCase() === repo.toLowerCase(),
    url: pr.html_url,
  };
}

/**
 * Moves the run's open PR to the default branch. A run that has not published
 * yet only needs the returned base: publication reads `run.stack.retargetedTo`.
 */
export async function retargetStackedPr(run: Run): Promise<StackRetargetResult> {
  const { repo, base } = await projectGitHub(run.project);
  if (!run.prNumber) return { base, result: `retargeted:before-publish->${base}` };
  if (run.prState === 'MERGED' || run.prState === 'CLOSED') {
    return { base, result: `skipped:#${run.prNumber} ${run.prState.toLowerCase()}` };
  }
  await ghApi(
    ['-X', 'PATCH', `repos/${repo}/pulls/${run.prNumber}`, '-f', `base=${base}`],
    `retargeting PR #${run.prNumber}`,
  );
  return { base, result: `retargeted:#${run.prNumber}->${base}` };
}

/**
 * Merges the default branch into a retargeted PR's head. After a squash merge
 * the head still carries the upstream's original commits; this makes the PR
 * diff show only the stacked run's work. Called only once nothing in the run's
 * family is active, so no warm worker holds a local branch that would diverge.
 * A conflict is left to the update-branch flow ci-watch dispatches.
 */
export async function updateStackedPrBranch(run: Run): Promise<StackRetargetResult> {
  const { repo, base } = await projectGitHub(run.project);
  if (!run.prNumber) return { base, result: 'update-branch:no-pr' };
  try {
    await ghApi(
      ['-X', 'PUT', `repos/${repo}/pulls/${run.prNumber}/update-branch`],
      `updating PR #${run.prNumber}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/conflict/i.test(message)) throw err;
    return { base, result: `update-branch:#${run.prNumber} conflict` };
  }
  return { base, result: `update-branch:#${run.prNumber} merged ${base}` };
}
