import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRReviewObservation, PRStatus } from '@farmslot/protocol';

import { prReviewReadiness } from './pr-review-status.js';
import type { PRWorkspaceEntry } from './pr-workspace.js';

const observation: PRReviewObservation = {
  observedAt: '2026-09-10T12:00:00.000Z',
  headSha: 'current',
  state: 'open',
  draft: false,
  decision: 'REVIEW_REQUIRED',
  reviewer: 'reader',
  requested: false,
  review: null,
};
const entry = (o?: PRReviewObservation): PRWorkspaceEntry => ({
  key: { repo: 'org/repo', pr: 1 },
  title: 'PR',
  author: 'teammate',
  monitors: [],
  reviews: [],
  requests: [],
  reviewObservations: o ? [o] : [],
});
test('overall GitHub requirements are primary even when the account already approved', () => {
  const result = prReviewReadiness(
    entry({ ...observation, review: { state: 'APPROVED', commit: 'current', submittedAt: null } }),
  );
  assert.equal(result.label, 'Reviews required');
  assert.equal(result.group, 'Needs review');
  assert.match(result.personal, /already reviewed this commit/);
  assert(result.blockedReason);
});
test('approval, changes requested, drafts and closed PRs do not inherit run-setup colors', () => {
  const cases = [
    [{ ...observation, decision: 'APPROVED' }, 'Approved', 'ok'],
    [{ ...observation, decision: 'CHANGES_REQUESTED' }, 'Changes requested', 'fail'],
    [{ ...observation, state: 'merged' as const }, 'Merged', 'muted'],
    [{ ...observation, draft: true }, 'Draft', 'muted'],
  ] as const;
  for (const [o, label, tone] of cases) {
    const result = prReviewReadiness(entry(o));
    assert.equal(result.label, label);
    assert.equal(result.tone, tone);
  }
  assert.equal(prReviewReadiness(entry()).label, 'Review status unknown');
});
test('a newer re-request supersedes an old satisfied observation for the same account', () => {
  const e = entry({ ...observation, requested: true, observedAt: '2026-09-10T13:00:00.000Z' });
  e.reviewObservations.push({ ...observation, reviewer: 'READER', decision: 'APPROVED' });
  assert.equal(prReviewReadiness(e).blockedReason, undefined);
});

test('fresh observation with no overall decision does not inherit stale PR status', () => {
  const result = prReviewReadiness({
    ...entry(),
    status: { reviewDecision: 'APPROVED', prState: 'OPEN' } as PRStatus,
    reviewObservations: [{ ...observation, decision: null }],
  });
  assert.equal(result.label, 'Review status unknown');
  assert.equal(result.blockedReason, undefined);
});
