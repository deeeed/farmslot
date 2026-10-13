// rereview.ts — "Re-review on latest head" for a review-pr run whose review
// could not be posted because the PR head moved.
//
// A verified retained lineage is required before replacing the parent. A live
// slot takes a chained WARM run; otherwise the same lineage goes through intake.
import {
  DEFAULT_PR_REVIEW_OPTIONS,
  isTerminalRunStatus,
  type Run,
  type RunRereviewLatestHeadParams,
  type RunRereviewLatestHeadResult,
} from '@farmslot/protocol';
import { reviewRequestContextForRun } from '@farmslot/review-dispatch';

import { fetchGitHubPR } from '../../external/github.js';
import {
  buildFollowUpClassification,
  buildFollowUpLineage,
} from '../../family-observability/context.js';
import { loadFleetStatus, loadProjectConfig } from '../../fleet/state.js';
import {
  assertRereviewable,
  liveReviewSessionSlot,
  rereviewTarget,
} from '../../pr-rules/rereview-request.js';
import { WarmReviewRefusal } from '../../review/session-mode.js';
import {
  automatedRepeatReviewSelection,
  buildRepeatReviewContext,
  confirmIncrementalAncestry,
} from '../../run-engine/engine-decisions.js';
import { applyChainedRunEngineFlags, startRun } from '../../run-engine/orchestrator.js';
import {
  assertPrimaryReviewContext,
  assertWarmReviewRequestAvailable,
} from '../../run-engine/review-plan.js';
import {
  operatorCompletionCollaborators,
  terminalTransitionDeps,
} from '../../run-lifecycle/terminal-transition.js';
import { routeRunTransition } from '../../run-lifecycle/transition-router.js';
import { createRun, getAllRuns, getRun, updateRun } from '../../runs/store.js';
import { withSourcePlanning } from '../../sources/runtime.js';
import { submitRereviewRequest } from '../pr-rules.js';

import { publishCompletedRun } from './lifecycle-control.js';

/** Mark a review that could not be posted as superseded so it stops owning the PR. */
async function supersedeBlockedReview(run: Run, successor: string): Promise<void> {
  if (run.status !== 'blocked') return;
  await routeRunTransition(
    { kind: 'supersede', runId: run.id, actor: 'operator' },
    terminalTransitionDeps({
      kind: 'supersede',
      runId: run.id,
      actor: 'operator',
      settlingStatus: 'blocked',
      patch: {
        status: 'done',
        completedAt: new Date().toISOString(),
        error: `${run.error ?? 'Review blocked.'} Superseded by re-review ${successor}.`,
      },
      collaborators: operatorCompletionCollaborators(publishCompletedRun),
    }),
  );
}

export async function runRereviewLatestHead(
  params: RunRereviewLatestHeadParams,
): Promise<RunRereviewLatestHeadResult> {
  const run = getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);
  return withSourcePlanning(run.project, () => rereviewWithSources(params));
}

async function rereviewWithSources(
  params: RunRereviewLatestHeadParams,
): Promise<RunRereviewLatestHeadResult> {
  const run = getRun(params.runId)!;
  assertRereviewable(run);
  const fallbackRepo = (await loadProjectConfig(run.project))?.ci?.repo;
  const target = rereviewTarget(run, fallbackRepo);
  // The head is fetched once for both paths: it keys the intake request and
  // seeds the warm continuation.
  const live = await fetchGitHubPR(`${target.repo}#${target.number}`);
  const slot = liveReviewSessionSlot(run, (await loadFleetStatus()).slots);
  const runner = run.metrics.runner;
  const model = run.metrics.model;
  const reviewContext = reviewRequestContextForRun({ ...run, decisions: run.decisions ?? [] });
  if (!reviewContext)
    throw new WarmReviewRefusal(
      'missing-session',
      'the previous review lineage is missing or ambiguous',
    );
  assertPrimaryReviewContext({ ...run, reviewMode: 'warm', reviewContext });
  // The stale review is the prior round, the live head is the target, and the
  // reviewer keeps its session. The context reads only the prior run, so its
  // ancestry lookup runs before the child exists.
  const context =
    slot && runner && model
      ? automatedRepeatReviewSelection(
          await confirmIncrementalAncestry(
            buildRepeatReviewContext(
              { ...run, reviewContext },
              run,
              {
                project: run.project,
                repository: target.repo.toLowerCase(),
                prNumber: target.number,
                headSha: live.headSha,
              },
              getAllRuns(),
            ),
          ),
          {
            ...DEFAULT_PR_REVIEW_OPTIONS,
            mode: 'warm',
          },
        )
      : undefined;

  // The parent may have been cancelled or superseded while GitHub answered.
  const parent = getRun(run.id);
  if (!parent) throw new Error(`Run not found: ${params.runId}`);
  assertRereviewable(parent);

  // A second click while the first chained round is still going returns it.
  // No await follows this check before the new child carries the head it matches.
  const existing = getAllRuns().find(
    (candidate) =>
      candidate.parentRunId === run.id &&
      candidate.flowType === 'review-pr' &&
      !isTerminalRunStatus(candidate.status) &&
      candidate.repeatReviewContext?.currentHeadSha === live.headSha,
  );
  if (existing) return { mode: 'warm-handoff', runId: existing.id, headSha: live.headSha };

  if (runner && model)
    assertWarmReviewRequestAvailable(
      parent,
      { runner, model, effort: run.effort ?? null, mode: 'warm', context: reviewContext },
      getAllRuns(),
    );

  if (!slot || !runner || !model || !context) {
    const intake = await submitRereviewRequest(run, fallbackRepo, live.headSha);
    const latestParent = getRun(parent.id);
    if (latestParent) await supersedeBlockedReview(latestParent, 'via review intake');
    return { mode: 'review-intake', ...intake };
  }

  const child = createRun({
    flowType: 'review-pr',
    project: run.project,
    // Original casing for display; the continuation context compares
    // repositories lower-cased, as engine-decisions does.
    ticketOrPr: `${target.repo}#${target.number}`,
    slotId: slot.slot,
    branch: run.branch ?? undefined,
    model,
    runner,
    effort: run.effort,
    mode: 'autonomous',
    safetyTier: run.safetyTier,
    // Keep the parent's completion policy: the operator was trying to post
    // this review, so the child must offer the same posting gate.
    completionPolicy: run.completionPolicy,
    reviewMode: context.mode,
    reviewContext,
    prNumber: target.number,
    ...buildFollowUpLineage(run),
    ...buildFollowUpClassification(run),
  });
  updateRun(child.id, {
    repeatReviewContext: context,
    reviewMode: context.mode,
    reviewValidationDepth: context.validationDepth,
  });
  applyChainedRunEngineFlags(child.id, { skipPrepare: true, warmSessionReuse: true });
  await supersedeBlockedReview(parent, child.id);
  console.log(
    `[run] re-review ${run.id.slice(0, 8)} → ${child.id.slice(0, 8)} on ${slot.slot}: warm handoff to the retained ${runner} session, ${context.priorReviewedHeadSha?.slice(0, 7) ?? '?'} → ${live.headSha.slice(0, 7)}`,
  );
  startRun(child.id).catch((err) => {
    console.error(
      `[run] re-review run ${child.id.slice(0, 8)} failed to start: ${(err as Error).message}`,
    );
  });
  return { mode: 'warm-handoff', runId: child.id, headSha: live.headSha };
}
