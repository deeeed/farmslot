import type { IndependentReviewStatus } from '@farmslot/protocol';

function issueLocation(issue: { file: string; line?: number }): string {
  return `${issue.file}${issue.line ? `:${issue.line}` : ''}`;
}

function reviewOutcomeSentence(review: IndependentReviewStatus): string {
  if (review.verdict === 'pass' && review.unresolvedCount === 0) {
    const issueAttempts = (review.attempts ?? []).filter((attempt) => attempt.issues?.length);
    if (issueAttempts.length > 0) {
      return `The reviewer initially reported ${issueAttempts.reduce((sum, attempt) => sum + (attempt.issues?.length ?? 0), 0)} finding(s); feedback was sent to the worker and the final re-review passed.`;
    }
    return 'The reviewer did not report unresolved findings.';
  }
  if (review.issues?.length) {
    return `The reviewer reported ${review.issues.length} unresolved ${review.issues.length === 1 ? 'finding' : 'findings'}.`;
  }
  if (review.unresolvedCount > 0) {
    return `The reviewer reported ${review.unresolvedCount} unresolved ${review.unresolvedCount === 1 ? 'finding' : 'findings'}, but structured issue details were not persisted for this legacy review.`;
  }
  if (review.verdict === 'skipped') {
    return 'This review was skipped.';
  }
  return 'No structured review findings were recorded.';
}

function workerFollowUpSentence(review: IndependentReviewStatus): string {
  if (review.fixDelta) {
    const base = review.fixDelta.fixBaseSha ?? review.fixDelta.baseSha ?? 'unknown';
    const head = review.fixDelta.fixHeadSha ?? review.fixDelta.headSha ?? 'unknown';
    const stat = review.fixDelta.diffStat
      ? ` (${review.fixDelta.diffStat.files} files, +${review.fixDelta.diffStat.additions}/-${review.fixDelta.diffStat.deletions})`
      : '';
    return `The worker applied a follow-up fix from ${base.slice(0, 7)} to ${head.slice(0, 7)}${stat}.`;
  }
  if (review.verdict === 'pass' && review.unresolvedCount === 0) {
    return 'No worker follow-up was required after this review.';
  }
  if (review.feedbackSent === false) {
    return 'This independent review was audit-only: its findings were recorded and the gate was blocked, but feedback was not automatically sent back to the worker.';
  }
  if (review.feedbackSent === true) {
    return 'Feedback was sent to the worker, but no fix delta was recorded.';
  }
  return 'No worker fix delta was recorded for this review loop yet.';
}

function reviewUsageLine(review: IndependentReviewStatus): string {
  const usage = review.usage;
  if (!usage || usage.source === 'unavailable') {
    const reason = usage?.error ? ` (${usage.error})` : '';
    return `- Usage: unavailable${reason}`;
  }
  const tokenParts = [
    usage.turns != null ? `${usage.turns} turns` : null,
    usage.inputTokens != null ? `${usage.inputTokens} input` : null,
    usage.outputTokens != null ? `${usage.outputTokens} output` : null,
    usage.totalTokens != null ? `${usage.totalTokens} total` : null,
    usage.costUsd != null ? `$${usage.costUsd.toFixed(4)}` : null,
  ].filter(Boolean);
  return `- Usage: ${tokenParts.length ? tokenParts.join(' · ') : 'measured'}${usage.runnerSessionId ? ` (session ${usage.runnerSessionId})` : ''}`;
}

export function formatIndependentReviewMarkdown(review: IndependentReviewStatus): string {
  const reviewedHead = review.reviewSnapshot?.headSha ?? 'unavailable';
  const reviewDiff = review.reviewSnapshot?.diffPath ?? 'unavailable';
  const fixDiff = review.fixDelta?.diffPath ?? null;
  const issueAttempts = (review.attempts ?? []).filter((attempt) => attempt.issues?.length);
  return [
    `# Independent Review ${review.loopNumber}`,
    '',
    `**Verdict:** ${review.verdict}${review.crossRunner ? ' (external review)' : ''}`,
    `**Reviewer:** ${review.runner ?? 'unknown'} / ${review.model ?? 'unknown'}`,
    `**Validation depth:** ${review.validationDepth ?? 'legacy/full-live'}`,
    `**Reviewed commit:** ${reviewedHead}`,
    '',
    '## Review',
    '',
    reviewOutcomeSentence(review),
    ...(review.issues?.length
      ? [
          '',
          ...review.issues.map((issue) => `- **${issueLocation(issue)}** — ${issue.description}`),
        ]
      : !review.issues?.length && issueAttempts.length
        ? [
            '',
            ...issueAttempts.flatMap((attempt) => [
              `Attempt ${attempt.loopNumber}:`,
              ...(attempt.issues ?? []).map(
                (issue) => `- **${issueLocation(issue)}** — ${issue.description}`,
              ),
            ]),
          ]
        : []),
    '',
    '## Worker follow-up',
    '',
    workerFollowUpSentence(review),
    ...(fixDiff ? ['', `- Fix diff: ${fixDiff}`] : []),
    '',
    '## Provenance',
    '',
    `- Source: ${review.source ?? 'self-review'}`,
    `- Validation depth: ${review.validationDepth ?? 'legacy/full-live'}`,
    reviewUsageLine(review),
    `- Feedback sent to worker: ${review.feedbackSent === undefined ? 'unknown' : review.feedbackSent ? 'yes' : 'no'}`,
    `- Unresolved findings: ${review.unresolvedCount}`,
    `- Review diff: ${reviewDiff}`,
    ...(review.stale ? ['- Status: stale versus current PR package'] : []),
    '',
    '## Artifacts',
    ...(review.artifactPaths?.length
      ? review.artifactPaths.map((artifact) => `- ${artifact}`)
      : ['- none']),
    '',
  ].join('\n');
}
