import {
  type MonitoredPRIdentity,
  monitoredPRKey,
  parseGitHubRef,
  type PRQaSourceReview,
  prReviewWorkflow,
  reviewResultForRun,
  type Run,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { getRunWithArchived } from '../runs/store.js';

function invalid(message: string): never {
  throw new GatewayMethodError('REVIEW_QA_NEEDS_CONFIGURATION', message);
}

/** Re-read the source at submission and immediately before delayed QA admission. */
type QaSourceReviewInput = {
  runId: string;
  ownerId: string;
  project?: string;
  pr: MonitoredPRIdentity;
  expected?: PRQaSourceReview;
  observedHeadSha?: string;
};

export async function validateQaSourceReview(
  input: QaSourceReviewInput,
): Promise<PRQaSourceReview> {
  return validateQaSourceReviewRecord(input, await getRunWithArchived(input.runId));
}

export function validateQaSourceReviewRecord(
  input: QaSourceReviewInput,
  run: Run | undefined,
): PRQaSourceReview {
  if (!run) invalid('Source review is unavailable');
  const owners = [
    run.createdByPrincipalId,
    run.nativeOwnerPrincipalId,
    run.prWork?.review?.ownerId,
  ].filter((owner): owner is string => owner !== undefined);
  if (!owners.length || owners.some((owner) => owner !== input.ownerId)) {
    throw new GatewayMethodError('AUTH_FORBIDDEN', 'Source review is not owned by this principal');
  }
  if (!input.project || run.project !== input.project)
    invalid('Source review belongs to another project');
  if (
    run.flowType !== 'review-pr' ||
    run.status !== 'done' ||
    run.reviewValidationDepth === 'full-live' ||
    run.reviewQaContract?.legacy?.validationDepth === 'full-live' ||
    (run.prWork?.review && prReviewWorkflow(run.prWork.review.options) === 'qa')
  ) {
    invalid('Source must be a completed static review');
  }
  const ref = parseGitHubRef(run.ticketOrPr);
  const pr =
    run.prWork?.pr ??
    (ref ? { host: 'github.com', repo: ref.repo, number: ref.number } : undefined);
  if (!pr || monitoredPRKey(pr) !== monitoredPRKey(input.pr))
    invalid('Source review belongs to another PR');
  const result = reviewResultForRun(run);
  const headSha = result?.reviewSnapshot?.headSha;
  if (
    !result ||
    typeof result.reviewMd !== 'string' ||
    !result.reviewMd.trim() ||
    !['github-pr', 'local-git'].includes(result.reviewSnapshot?.source ?? '') ||
    typeof headSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(headSha) ||
    ('stale' in result && result.stale === true)
  ) {
    invalid('Source review has no confirmed exact-head result');
  }
  if (
    (run.prWork && run.prWork.headSha !== headSha) ||
    (run.reviewWorkspaceSubject &&
      (run.reviewWorkspaceSubject.headSha !== headSha ||
        run.reviewWorkspaceSubject.repository.toLowerCase() !== input.pr.repo.toLowerCase()))
  ) {
    invalid('Source review result disagrees with its frozen PR target');
  }
  if (input.expected && (input.expected.runId !== run.id || input.expected.headSha !== headSha))
    invalid('Source review changed after this QA request');
  if (input.observedHeadSha !== undefined && input.observedHeadSha !== headSha)
    invalid(
      'PR head changed since the source review; review the current head before running linked QA',
    );
  return { runId: run.id, headSha };
}
