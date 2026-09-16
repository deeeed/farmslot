import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  captureQaAfterReview,
  type ProjectConfig,
  type PRReviewSubmission,
  resolvePRWorkflowDefaults,
  ReviewQaConfigurationError,
  type Run,
} from '@farmslot/protocol';

import { getRunWithArchived } from '../runs/store.js';

export function automaticQaKey(runId: string, profileId: string): string {
  return `qa-after-review:${createHash('sha256')
    .update(JSON.stringify([runId, profileId]))
    .digest('hex')}`;
}

/** A reserved key only adds restrictions; the gateway-owned run snapshot supplies authority. */
export async function automaticQaSource(submission: PRReviewSubmission): Promise<Run | undefined> {
  const run = submission.request.sourceReviewRunId
    ? await getRunWithArchived(submission.request.sourceReviewRunId)
    : undefined;
  if (
    !run?.qaAfterReview ||
    submission.request.idempotencyKey !==
      automaticQaKey(run.id, run.qaAfterReview.selection.profile.id)
  )
    return undefined;
  return run;
}

export function assertAutomaticQaPolicy(run: Run, project: ProjectConfig | null): void {
  const snapshot = run.qaAfterReview;
  if (!snapshot)
    throw new ReviewQaConfigurationError(
      'Automatic QA was not enabled when this review was admitted',
    );
  if (!project?.qa?.after_review?.enabled)
    throw new ReviewQaConfigurationError('Automatic QA is currently disabled for this farm');
  if (project.qa.after_review.profile_id !== snapshot.selection.profile.id)
    throw new ReviewQaConfigurationError(
      'Automatic QA profile changed after static-review admission',
    );
  const current = captureQaAfterReview(
    project.qa,
    resolvePRWorkflowDefaults({ workflow: 'qa', farm: project.workflowDefaults }),
  );
  if (
    !current ||
    !isDeepStrictEqual(current.selection, snapshot.selection) ||
    !isDeepStrictEqual(current.execution, snapshot.execution) ||
    !isDeepStrictEqual(current.review, snapshot.review)
  ) {
    throw new ReviewQaConfigurationError(
      'Automatic QA defaults changed after static-review admission; use explicit Run QA for the new selection',
    );
  }
}

export function assertAutomaticQaRequest(run: Run, submission: PRReviewSubmission): void {
  const snapshot = run.qaAfterReview!;
  if (
    submission.request.sourceReviewRunId !== run.id ||
    !isDeepStrictEqual(submission.request.review, snapshot.review) ||
    !isDeepStrictEqual(submission.request.execution, snapshot.execution) ||
    !submission.request.autoStart ||
    (snapshot.teamId !== undefined && snapshot.teamId !== submission.request.teamId)
  ) {
    throw new ReviewQaConfigurationError(
      'Automatic QA receipt does not match its frozen selection',
    );
  }
}
