// rereview.ts — "Re-review on latest head" for a review-pr run whose review
// could not be posted because the PR head moved.
//
// Two paths, decided by whether the reviewer session that produced the stale
// review is still alive on the run's slot:
//
// 1. Warm handoff (preferred): the slot still hosts the run's review context,
//    so a chained review-pr run is created on that slot with the ci-watch
//    warm-session flags. DISPATCH pastes the follow-up task into the live
//    session, and the incremental repeat-review context (prior findings,
//    reviewed SHA vs. current head) is attached up front so no continuation
//    gate is raised. This is "reload the previous runner context".
// 2. Review intake (fallback): the session is gone, so a manual review request
//    (resume session, incremental scope, same slot/runner/model preferred) goes
//    through the normal review queue and reviewer continuity picks the best
//    available session.

import {
  DEFAULT_PR_REVIEW_OPTIONS,
  isTerminalRunStatus,
  type Run,
  type RunRereviewLatestHeadParams,
  type RunRereviewLatestHeadResult,
} from '@farmslot/protocol';

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
import {
  automatedRepeatReviewSelection,
  buildRepeatReviewContext,
} from '../../run-engine/engine-decisions.js';
import { applyChainedRunEngineFlags, startRun } from '../../run-engine/orchestrator.js';
import { createRun, getAllRuns, getRun, updateRun } from '../../runs/store.js';
import { submitRereviewRequest } from '../pr-rules.js';

/** Mark a review that could not be posted as superseded so it stops owning the PR. */
function supersedeBlockedReview(run: Run, successor: string): void {
  if (run.status !== 'blocked') return;
  updateRun(run.id, {
    status: 'done',
    completedAt: new Date().toISOString(),
    error: `${run.error ?? 'Review blocked.'} Superseded by re-review ${successor}.`,
  });
}

export async function runRereviewLatestHead(
  params: RunRereviewLatestHeadParams,
): Promise<RunRereviewLatestHeadResult> {
  const run = getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);
  assertRereviewable(run);
  const fallbackRepo = (await loadProjectConfig(run.project))?.ci?.repo;
  const target = rereviewTarget(run, fallbackRepo);
  // The head is fetched once for both paths: it keys the intake request and
  // seeds the warm continuation.
  const live = await fetchGitHubPR(`${target.repo}#${target.number}`);

  // A second click while the first chained round is still going returns it.
  const existing = getAllRuns().find(
    (candidate) =>
      candidate.parentRunId === run.id &&
      candidate.flowType === 'review-pr' &&
      !isTerminalRunStatus(candidate.status) &&
      candidate.repeatReviewContext?.currentHeadSha === live.headSha,
  );
  if (existing) return { mode: 'warm-handoff', runId: existing.id, headSha: live.headSha };

  const slot = liveReviewSessionSlot(run, (await loadFleetStatus()).slots);
  const runner = run.metrics.runner;
  const model = run.metrics.model;
  if (!slot || !runner || !model) {
    // The blocked review still owns the PR for queue admission; retire it or
    // the replacement waits on the run it replaces.
    supersedeBlockedReview(run, 'via review intake');
    const intake = await submitRereviewRequest(run, fallbackRepo, live.headSha);
    return { mode: 'review-intake', ...intake };
  }

  const child = createRun({
    flowType: 'review-pr',
    project: run.project,
    // Original casing for display; the continuation context below compares
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
    reviewScope: 'incremental',
    prNumber: target.number,
    ...buildFollowUpLineage(run),
    ...buildFollowUpClassification(run),
  });
  // Attach the continuation up front: the stale review is the prior round,
  // the live head is the target, and the reviewer keeps its session.
  const context = automatedRepeatReviewSelection(
    buildRepeatReviewContext(
      child,
      run,
      {
        project: run.project,
        repository: target.repo.toLowerCase(),
        prNumber: target.number,
        headSha: live.headSha,
      },
      getAllRuns(),
    ),
    {
      ...DEFAULT_PR_REVIEW_OPTIONS,
      validationDepth: run.reviewValidationDepth ?? DEFAULT_PR_REVIEW_OPTIONS.validationDepth,
      busySession: 'wait',
    },
  );
  updateRun(child.id, {
    repeatReviewContext: context,
    reviewScope: context.reviewScope,
    reviewValidationDepth: context.validationDepth,
  });
  applyChainedRunEngineFlags(child.id, { skipPrepare: true, warmSessionReuse: true });
  supersedeBlockedReview(run, child.id);
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
