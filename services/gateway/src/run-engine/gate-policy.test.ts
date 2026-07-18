import assert from 'node:assert/strict';
import test from 'node:test';

import type { IndependentReviewStatus } from '@farmslot/protocol';

import {
  buildNoChangeGateInputs,
  isOwnPrApprovalError,
  noChangeDispositionLabel,
  noChangeRejectionMessage,
  shouldForceNoChangeHumanGate,
  staleReviewsAreEvidenceOnly,
} from './gate-policy.js';
import { makeReadyGatePackage, makeRun } from './test-fixtures.js';

function makeApprovingReview(
  overrides: Partial<IndependentReviewStatus> = {},
): IndependentReviewStatus {
  return {
    id: overrides.id ?? 'review-1',
    source: overrides.source ?? 'human-gate',
    crossRunner: overrides.crossRunner ?? false,
    loopNumber: overrides.loopNumber ?? 1,
    verdict: overrides.verdict ?? 'pass',
    unresolvedCount: overrides.unresolvedCount ?? 0,
    reviewedHeadSha: 'reviewedHeadSha' in overrides ? overrides.reviewedHeadSha : 'abc1234',
    reviewedReviewSubjectHash:
      'reviewedReviewSubjectHash' in overrides
        ? overrides.reviewedReviewSubjectHash
        : 'subject-old',
    ...overrides,
  };
}

test('isOwnPrApprovalError detects GitHub self-approval failures', () => {
  assert.equal(
    isOwnPrApprovalError(
      new Error('GraphQL: Review Can not approve your own pull request (addPullRequestReview)'),
    ),
    true,
  );
  assert.equal(
    isOwnPrApprovalError({ stderr: 'GraphQL: Review cannot approve your own pull request' }),
    true,
  );
  assert.equal(
    isOwnPrApprovalError(new Error('GraphQL: Resource not accessible by integration')),
    false,
  );
});

test('shouldForceNoChangeHumanGate forces only fix-bug no-code dispositions', () => {
  assert.equal(
    shouldForceNoChangeHumanGate(
      makeRun({
        flowType: 'fix-bug',
        metrics: { nudgeCount: 0, model: 'gpt-5.5', runner: 'codex', disposition: 'already_fixed' },
      }),
    ),
    true,
  );
  assert.equal(
    shouldForceNoChangeHumanGate(
      makeRun({
        flowType: 'fix-bug',
        metrics: {
          nudgeCount: 0,
          model: 'gpt-5.5',
          runner: 'codex',
          disposition: 'not_reproducible',
        },
      }),
    ),
    true,
  );
  assert.equal(
    shouldForceNoChangeHumanGate(
      makeRun({
        flowType: 'fix-bug',
        metrics: { nudgeCount: 0, model: 'gpt-5.5', runner: 'codex', disposition: 'fixed' },
      }),
    ),
    false,
  );
  assert.equal(
    shouldForceNoChangeHumanGate(
      makeRun({
        flowType: 'dev',
        metrics: { nudgeCount: 0, model: 'gpt-5.5', runner: 'codex', disposition: 'already_fixed' },
      }),
    ),
    false,
  );
});

test('noChangeDispositionLabel renders operator labels', () => {
  assert.equal(noChangeDispositionLabel('already_fixed'), 'already fixed');
  assert.equal(noChangeDispositionLabel('not_reproducible'), 'not reproducible');
  assert.equal(noChangeDispositionLabel('fixed'), 'fixed');
});

test('buildNoChangeGateInputs renders full evidence into desc + payload', () => {
  const { desc, payload } = buildNoChangeGateInputs({
    disposition: 'already_fixed',
    ticketOrPr: 'EXAMPLE/repo#1234',
    monitorReason: 'Behaviour matches AC on current main',
    evidence: {
      reportPath: 'artifacts/no-change-report.md',
      artifacts: ['artifacts/proof-1.png', 'artifacts/proof-2.png'],
      confidence: 'high',
    },
    report: 'Verified on main @ abc1234. AC1, AC2, AC3 all pass.',
  });

  assert.match(desc, /Worker reported \*\*already fixed\*\* for EXAMPLE\/repo#1234/);
  assert.match(desc, /Worker reason: Behaviour matches AC on current main/);
  assert.match(desc, /- report: `artifacts\/no-change-report\.md`/);
  assert.match(desc, /- artifact: `artifacts\/proof-1\.png`/);
  assert.match(desc, /- artifact: `artifacts\/proof-2\.png`/);
  assert.match(desc, /- confidence: high/);
  assert.doesNotMatch(desc, /reproduction attempted/);
  assert.match(desc, /Report excerpt:\n\nVerified on main @ abc1234/);

  assert.equal(payload.kind, 'no-change');
  assert.equal(payload.disposition, 'already_fixed');
  assert.equal(payload.reason, 'Behaviour matches AC on current main');
  assert.equal(payload.evidence?.confidence, 'high');
  assert.equal(payload.workerReport, 'Verified on main @ abc1234. AC1, AC2, AC3 all pass.');
});

test('buildNoChangeGateInputs falls back to "none reported" when evidence is absent', () => {
  const { desc, payload } = buildNoChangeGateInputs({
    disposition: 'not_reproducible',
    ticketOrPr: 'JIRA-9001',
  });

  assert.match(desc, /Worker reported \*\*not reproducible\*\* for JIRA-9001/);
  assert.match(desc, /Evidence: none reported\./);
  assert.doesNotMatch(desc, /Worker reason:/);
  assert.doesNotMatch(desc, /Report excerpt:/);
  assert.equal(payload.workerReport, undefined);
  assert.equal(payload.evidence, undefined);
  assert.equal(payload.reason, undefined);
});

test('buildNoChangeGateInputs caps long reports at 600 chars', () => {
  const longReport = 'x'.repeat(2000);
  const { desc } = buildNoChangeGateInputs({
    disposition: 'already_fixed',
    ticketOrPr: 'JIRA-1',
    report: longReport,
  });
  const excerpt = desc.split('Report excerpt:\n\n')[1] ?? '';
  assert.equal(excerpt.length, 600);
});

test('noChangeRejectionMessage formats reject-retry vs mark-blocked', () => {
  assert.equal(
    noChangeRejectionMessage('reject-retry', 'JIRA-42'),
    'No-change result rejected; retry reproduction for JIRA-42',
  );
  assert.equal(
    noChangeRejectionMessage('mark-blocked', 'JIRA-42'),
    'No-change result marked blocked; insufficient evidence for JIRA-42',
  );
});

test('staleReviewsAreEvidenceOnly is true for subject drift with matching HEAD', () => {
  const preparedPackage = makeReadyGatePackage({
    headSha: 'abc1234',
    reviewSubjectHash: 'subject-new',
  });
  const reviews = [
    makeApprovingReview({ reviewedHeadSha: 'abc1234', reviewedReviewSubjectHash: 'subject-old' }),
  ];
  assert.equal(staleReviewsAreEvidenceOnly(reviews, preparedPackage), true);
});

test('staleReviewsAreEvidenceOnly is false when reviewed HEAD differs (code changed)', () => {
  const preparedPackage = makeReadyGatePackage({
    headSha: 'def5678',
    reviewSubjectHash: 'subject-new',
  });
  const reviews = [
    makeApprovingReview({ reviewedHeadSha: 'abc1234', reviewedReviewSubjectHash: 'subject-old' }),
  ];
  assert.equal(staleReviewsAreEvidenceOnly(reviews, preparedPackage), false);
});

test('staleReviewsAreEvidenceOnly is false when no stale approving review exists', () => {
  const preparedPackage = makeReadyGatePackage({
    headSha: 'abc1234',
    reviewSubjectHash: 'subject-current',
  });
  // Review already certifies the current subject + HEAD — nothing stale to carry forward.
  const fresh = [
    makeApprovingReview({
      reviewedHeadSha: 'abc1234',
      reviewedReviewSubjectHash: 'subject-current',
    }),
  ];
  assert.equal(staleReviewsAreEvidenceOnly(fresh, preparedPackage), false);
  // No approving review at all (only an issues verdict) — override unavailable.
  const failing = [
    makeApprovingReview({
      verdict: 'issues',
      unresolvedCount: 2,
      reviewedReviewSubjectHash: 'subject-old',
    }),
  ];
  assert.equal(staleReviewsAreEvidenceOnly(failing, preparedPackage), false);
});

test('staleReviewsAreEvidenceOnly is false when any stale approving review is HEAD-drifted', () => {
  const preparedPackage = makeReadyGatePackage({
    headSha: 'abc1234',
    reviewSubjectHash: 'subject-new',
  });
  const reviews = [
    makeApprovingReview({
      id: 'review-1',
      reviewedHeadSha: 'abc1234',
      reviewedReviewSubjectHash: 'subject-old',
    }),
    makeApprovingReview({
      id: 'review-2',
      reviewedHeadSha: 'def5678',
      reviewedReviewSubjectHash: 'subject-old',
    }),
  ];
  assert.equal(staleReviewsAreEvidenceOnly(reviews, preparedPackage), false);
});

test('staleReviewsAreEvidenceOnly respects cross-runner certification requirement', () => {
  const preparedPackage = makeReadyGatePackage({
    headSha: 'abc1234',
    reviewSubjectHash: 'subject-new',
  });
  // Only a same-runner stale approval exists; with cross-runner required there is
  // no eligible stale approving review, so the override stays unavailable.
  const reviews = [
    makeApprovingReview({
      crossRunner: false,
      reviewedHeadSha: 'abc1234',
      reviewedReviewSubjectHash: 'subject-old',
    }),
  ];
  assert.equal(
    staleReviewsAreEvidenceOnly(reviews, preparedPackage, {
      requireCrossRunnerCertification: true,
    }),
    false,
  );
  assert.equal(staleReviewsAreEvidenceOnly(reviews, preparedPackage), true);
});
