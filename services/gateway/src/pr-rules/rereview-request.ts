// rereview-request.ts — build the manual review request that re-reviews a
// blocked review-pr run on the PR's current head (ADR-055 reviewer continuity).
//
// A review that could not be posted because the head moved is not lost work:
// a new round with `sessionIntent: 'resume'` and `scope: 'incremental'` lets
// the dispatcher reuse the retained reviewer session and hand it only the new
// diff plus the unresolved findings. The request goes through the same intake
// as "Request review / QA", so admission, authorization and the queue apply.

import {
  parseGitHubRef,
  type PRReviewRequest,
  type Run,
  type SlotStatus,
} from '@farmslot/protocol';

export interface RereviewTeamCandidate {
  id: string;
  config: { name?: string; repositories: Array<{ repo: string; project?: string }> };
}

export type RereviewRun = Pick<
  Run,
  | 'id'
  | 'flowType'
  | 'status'
  | 'project'
  | 'ticketOrPr'
  | 'prNumber'
  | 'slotId'
  | 'reviewWorkspaceTarget'
  | 'transport'
  | 'effort'
  | 'reviewValidationDepth'
> & { metrics: Pick<Run['metrics'], 'runner' | 'model'> };

/** Repo slug and number of the PR a review-pr run reviewed. */
export function rereviewTarget(
  run: Pick<Run, 'ticketOrPr' | 'prNumber'>,
  fallbackRepo?: string,
): { repo: string; number: number } {
  const ref = parseGitHubRef(run.ticketOrPr);
  const repo = ref?.repo ?? fallbackRepo;
  const number = run.prNumber ?? ref?.number;
  if (!repo || !number)
    throw new Error(`Run ${run.ticketOrPr} does not identify a GitHub PR to re-review`);
  return { repo, number };
}

/**
 * Pick the review team whose repositories cover the PR, preferring the one
 * mapped to the run's project. Several matches with no project tie-break is
 * ambiguous and must be resolved by the operator through "Request review / QA".
 */
export function selectRereviewTeam(
  teams: readonly RereviewTeamCandidate[],
  repo: string,
  project: string,
): RereviewTeamCandidate {
  const covering = teams.filter((team) =>
    team.config.repositories.some((entry) => entry.repo.toLowerCase() === repo.toLowerCase()),
  );
  if (covering.length === 0)
    throw new Error(
      `No review team covers ${repo}; add one under PRs → Automation or use Request review / QA`,
    );
  const byProject = covering.filter((team) =>
    team.config.repositories.some(
      (entry) => entry.repo.toLowerCase() === repo.toLowerCase() && entry.project === project,
    ),
  );
  const pool = byProject.length ? byProject : covering;
  if (pool.length > 1)
    throw new Error(
      `${pool.length} review teams cover ${repo} (${pool
        .map((team) => team.config.name ?? team.id)
        .join(', ')}); use Request review / QA to choose one`,
    );
  return pool[0];
}

export function assertRereviewable(run: Pick<Run, 'id' | 'flowType' | 'status'>): void {
  if (run.flowType !== 'review-pr')
    throw new Error(`Run ${run.id} is a ${run.flowType} run, not a review`);
  if (run.status !== 'blocked' && run.status !== 'done' && run.status !== 'failed')
    throw new Error(
      `Run ${run.id} is ${run.status}; re-review applies to a finished or blocked review`,
    );
}

/**
 * The slot that still hosts this run's reviewer session: its review agent
 * context is bound to the run and the worker is still up. That session can
 * take the follow-up directly instead of a fresh launch.
 */
export function liveReviewSessionSlot(
  run: Pick<Run, 'id' | 'slotId'>,
  slots: readonly Pick<SlotStatus, 'slot' | 'agent' | 'agentContexts'>[],
): Pick<SlotStatus, 'slot' | 'agent' | 'agentContexts'> | undefined {
  if (!run.slotId) return undefined;
  const slot = slots.find((item) => item.slot === run.slotId);
  if (!slot || slot.agent !== 'working') return undefined;
  const hosts = (slot.agentContexts ?? []).some(
    (context) => context.runId === run.id && context.role === 'review',
  );
  return hosts ? slot : undefined;
}

/**
 * The caller has already checked the run with `assertRereviewable`. `headSha`
 * is the PR head being re-reviewed: repeated clicks at the same head collapse
 * into one request, a moved head opens a new round.
 */
export function buildRereviewRequest(
  run: RereviewRun,
  teams: readonly RereviewTeamCandidate[],
  ownerId: string,
  options: { fallbackRepo?: string; headSha: string },
): PRReviewRequest {
  const target = rereviewTarget(run, options.fallbackRepo);
  const team = selectRereviewTeam(teams, target.repo, run.project);
  const runner = run.metrics.runner;
  const model = run.metrics.model;
  return {
    teamId: team.id,
    pr: { host: 'github.com', repo: target.repo, number: target.number },
    idempotencyKey: `rereview:${run.id}:${options.headSha}`,
    autoStart: true,
    // Same slot, runner and model as the blocked round so the retained
    // reviewer session is the preferred choice; the team/rule config decides
    // when the run did not record them.
    ...(run.reviewWorkspaceTarget && runner && model
      ? {
          execution: {
            workspacePolicy: { kind: 'exact' as const, machine: run.reviewWorkspaceTarget.machine },
            transport: run.transport ?? 'tmux',
            models: [{ runner, model, ...(run.effort ? { effort: run.effort } : {}) }],
          },
        }
      : run.slotId && runner && model
        ? {
            execution: {
              slotPolicy: { kind: 'exact' as const, slotId: run.slotId },
              models: [{ runner, model, ...(run.effort ? { effort: run.effort } : {}) }],
            },
          }
        : {}),
    review: {
      sessionIntent: 'resume',
      scope: 'incremental',
      // Same depth as the review being redone; a dead session is no reason to go shallower.
      validationDepth: run.reviewValidationDepth ?? 'static-code',
      busySession: 'wait',
    },
    source: { client: 'command-center', reference: `run:${run.id}`, requester: ownerId },
  };
}
