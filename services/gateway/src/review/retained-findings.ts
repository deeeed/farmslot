import type { ReviewStatus } from '@farmslot/protocol';

/** An unchanged, blocked worker fix does not erase the review that raised its findings. */
export function preserveUnchangedReviewFindings(review: ReviewStatus): ReviewStatus {
  const final = review.attempts?.at(-1);
  const delta = final?.fixDelta;
  if (
    review.verdict !== 'failed' ||
    final?.verdict !== 'failed' ||
    final.reviewSnapshot ||
    delta?.source !== 'local-git' ||
    delta.diffStat?.files !== 0 ||
    (delta.untrackedFiles?.length ?? 0) !== 0 ||
    !delta.fixHeadSha ||
    delta.fixBaseSha !== delta.fixHeadSha
  )
    return review;
  const prior = review.attempts
    ?.slice(0, -1)
    .reverse()
    .find((attempt) => attempt.verdict === 'pass' || attempt.verdict === 'issues');
  if (
    prior?.verdict !== 'issues' ||
    !prior.issues?.length ||
    prior.reviewSnapshot?.headSha !== delta.fixHeadSha
  )
    return review;
  return {
    ...review,
    mode: prior.mode,
    session: prior.session ?? review.session,
    verdict: 'issues',
    unresolvedCount: prior.unresolvedCount,
    issues: prior.issues,
    reviewSnapshot: prior.reviewSnapshot,
    reviewedHeadSha: prior.reviewSnapshot.headSha,
    reviewerSessionId:
      prior.session?.sessionId ?? prior.usage?.runnerSessionId ?? review.reviewerSessionId,
    validationDepth: prior.validationDepth ?? review.validationDepth,
    usage: prior.usage ?? review.usage,
    taskProgressArtifactPath: prior.taskProgressArtifactPath ?? review.taskProgressArtifactPath,
  };
}
