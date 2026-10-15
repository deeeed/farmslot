import type {
  ReviewDiffSnapshot,
  ReviewSessionTrace,
  Run,
  RunReviewResult,
} from '@farmslot/protocol';
import { resolveReviewMode } from '@farmslot/review-dispatch';

import { upsertAgentContext } from '../agents/contexts.js';
import { reviewPRIdentity } from '../review/session-mode.js';
import { retainedRunArtifactManifest } from '../run-completion/retained-artifacts.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';

import { readReviewInputSnapshot } from './diff-artifacts.js';
import { copyWorkerArtifacts, readReviewArtifacts } from './review-artifacts.js';

/** Preserve completed review evidence without creating a publication decision. */
export async function recordArtifactOnlyReviewResult(runId: string): Promise<RunReviewResult> {
  const run = getRun(runId);
  if (!run || run.flowType !== 'review-pr' || run.completionPolicy !== 'artifact-only') {
    throw new Error('Artifact-only review evidence requires an artifact-only review run');
  }
  if (run.reviewResult) return run.reviewResult;
  if (!run.taskFile) throw new Error('Review task is missing');
  const monitor = run.steps.find((step) => step.name === 'monitor');
  const signal = monitor?.outputs?.workerSignal as
    | { status?: string; outcome?: string }
    | undefined;
  if (monitor?.status !== 'done' || signal?.status !== 'complete' || signal.outcome !== 'success') {
    throw new Error('Review has no successful worker completion signal');
  }
  // Read only the inputs frozen before dispatch. Fetching current PR metadata
  // here would attribute the report to a commit the worker may never have seen.
  const input = await readReviewInputSnapshot(run.taskFile);
  const dispatchedAt = run.steps.find((step) => step.name === 'dispatch')?.startedAt;
  if (
    !input.snapshot ||
    input.snapshot.source === 'unavailable' ||
    !/^[0-9a-f]{40}$/i.test(input.snapshot.headSha ?? '') ||
    !dispatchedAt ||
    !Number.isFinite(Date.parse(input.snapshot.capturedAt)) ||
    Date.parse(input.snapshot.capturedAt) > Date.parse(dispatchedAt)
  ) {
    throw new Error('Review is missing its pre-dispatch commit snapshot');
  }
  await copyWorkerArtifacts(runId);
  const captured = getRun(runId)!;
  const review = await readReviewArtifacts(runId, captured.artifactBundle);
  if (!review.hasReview || !review.reviewMd.trim())
    throw new Error('Worker review report is missing');
  const result: RunReviewResult = {
    recommendation: review.recommendation,
    reviewMd: review.reviewMd,
    lineComments: review.lineComments,
    reviewSnapshot: input.snapshot,
    reviewInputArtifactPaths: input.artifactPaths,
    artifactManifest: (await retainedRunArtifactManifest(captured)).filter((artifact) =>
      artifact.path.startsWith('artifacts/'),
    ),
    session: await completedReviewSessionTrace(run, input.snapshot),
  };
  await persistRunNow(updateRun(runId, { reviewResult: result }), 'artifact-only review evidence');
  return result;
}

/** Bind a completed primary review to captured session and immutable PR input facts. */
export async function completedReviewSessionTrace(
  run: Run,
  snapshot: ReviewDiffSnapshot | undefined,
): Promise<ReviewSessionTrace | undefined> {
  const identity = reviewPRIdentity(run);
  const reviewers = (run.agentContexts ?? []).filter(
    (context) =>
      context.role === 'review' &&
      context.status === 'complete' &&
      context.reviewId &&
      context.runnerSessionId &&
      (context.runnerSessionCapturedAt || context.nativeSession?.acceptedAt),
  );
  if (
    !identity ||
    !snapshot?.headSha ||
    snapshot.source === 'unavailable' ||
    reviewers.length !== 1
  )
    return undefined;
  const reviewer = reviewers[0];
  const mode = resolveReviewMode({ run });
  const prior = run.repeatReviewContext?.session;
  if (
    mode === 'warm' &&
    (prior?.continuity !== 'resumed' ||
      prior.reviewId !== reviewer.reviewId ||
      prior.sessionId !== reviewer.runnerSessionId)
  )
    return undefined;
  await upsertAgentContext(run.id, 'review', {
    id: reviewer.id,
    reviewResultValidatedAt: new Date().toISOString(),
  });
  return {
    ...(mode === 'warm' ? prior : {}),
    mode,
    continuity: mode === 'warm' ? 'resumed' : 'fresh',
    repository: identity.repository,
    prNumber: identity.prNumber,
    reviewId: reviewer.reviewId,
    sessionId: reviewer.runnerSessionId!,
    lastReviewedHeadSha: mode === 'warm' ? prior?.lastReviewedHeadSha : snapshot.headSha,
  };
}
