'use strict';

const DEFAULT_APPROVAL_POLICY = Object.freeze({
  maxNits: 3,
  minorVerdict: 'COMMENT',
  majorVerdict: 'REQUEST_CHANGES',
});
const verdicts = ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'];
const severities = ['blocker', 'major', 'minor', 'nit'];

function isReviewSeverity(value) {
  return severities.includes(value);
}

function resolveApprovalPolicy(value) {
  if (value === undefined) return { ...DEFAULT_APPROVAL_POLICY };
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_APPROVAL_POLICY, key))
  )
    throw new Error('approvalPolicy accepts only maxNits, minorVerdict and majorVerdict');
  const policy = { ...DEFAULT_APPROVAL_POLICY, ...value };
  if (
    !Number.isSafeInteger(policy.maxNits) ||
    policy.maxNits < 0 ||
    !verdicts.includes(policy.minorVerdict) ||
    !verdicts.includes(policy.majorVerdict)
  )
    throw new Error(
      'Invalid approvalPolicy: maxNits must be nonnegative and verdicts must be APPROVE, COMMENT or REQUEST_CHANGES',
    );
  return policy;
}

function normalizeReviewSeverity(value) {
  const legacy = { must_fix: 'major', suggestion: 'minor', nitpick: 'nit', comment: 'nit' };
  const severity = legacy[value] ?? value ?? 'major';
  if (!isReviewSeverity(severity))
    throw new Error('Review severity must be blocker, major, minor or nit');
  return severity;
}

function reviewRecommendation(findings, value) {
  const policy = resolveApprovalPolicy(value);
  const counts = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const finding of findings) {
    // Older results omitted severity; they cannot grant an approval.
    const severity = normalizeReviewSeverity(finding.severity);
    counts[severity]++;
  }
  const required = ['APPROVE'];
  if (counts.blocker) required.push('REQUEST_CHANGES');
  if (counts.major) required.push(policy.majorVerdict);
  if (counts.minor) required.push(policy.minorVerdict);
  if (counts.nit > policy.maxNits) required.push('COMMENT');
  return verdicts[Math.max(...required.map((verdict) => verdicts.indexOf(verdict)))];
}

class ReviewApprovalPolicyError extends Error {
  constructor(recommendation) {
    super(
      `Review recommendation conflicts with approvalPolicy; findings require ${recommendation}`,
    );
    this.code = 'REVIEW_POLICY_CONFLICT';
    this.recommendation = recommendation;
  }
}

function assertReviewRecommendation(findings, recommendation, policy) {
  const required = reviewRecommendation(findings, policy);
  if (recommendation !== required && !(required === 'APPROVE' && recommendation === 'COMMENT'))
    throw new ReviewApprovalPolicyError(required);
  return recommendation;
}

function renderApprovalPolicy(value) {
  const policy = resolveApprovalPolicy(value);
  return [
    '## Review approval policy',
    '',
    `Blocker requires REQUEST_CHANGES; major requires ${policy.majorVerdict}; minor requires ${policy.minorVerdict}; more than ${policy.maxNits} nits requires COMMENT. Use the strictest applicable verdict, otherwise APPROVE. COMMENT includes concrete asks.`,
    'Minor means a real defect or gap: wrong value, changed behavior without a test, false PR-description claim or duplication of an existing helper. Nit means style or wording with no behavior impact. Size alone is never a finding. Unrelated concerns mixed in one PR are a minor asking to split.',
    'Record every finding with severity blocker, major, minor or nit. Put out-of-diff notes in the review body; every inline comment must resolve to a RIGHT-side added or context line in the PR diff at the reviewed head.',
  ].join('\n');
}

function renderReviewResultInstructions(resultRelPath) {
  return `

## Machine-readable review result

Write \`${resultRelPath}\` as JSON before completing:

\`\`\`json
{
  "schemaVersion": 1,
  "verdict": "pass",
  "recommendation": "APPROVE",
  "issues": []
}
\`\`\`

For an issues verdict, set \`verdict\` to \`"issues"\` and include at least one
\`{ "file": "path", "line": 1, "description": "specific finding", "severity": "minor" }\` entry.
Use verdict pass when the shared approval policy permits APPROVE, otherwise issues. The recommendation must match that policy. Retain permitted nits in issues even with verdict pass.
Omit line for body-only findings without a source location.
The JSON verdict and issues are authoritative; the Markdown file is the human-readable report.`;
}

module.exports = {
  normalizeReviewSeverity,
  renderReviewResultInstructions,
  isReviewSeverity,
  DEFAULT_APPROVAL_POLICY,
  resolveApprovalPolicy,
  reviewRecommendation,
  assertReviewRecommendation,
  renderApprovalPolicy,
  ReviewApprovalPolicyError,
};
