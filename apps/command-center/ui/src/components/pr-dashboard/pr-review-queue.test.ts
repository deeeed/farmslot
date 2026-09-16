import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRReviewObservation, PRStatus } from '@farmslot/protocol';

import { prReviewQueue } from './pr-review-queue.js';
import type { PRWorkspaceEntry } from './pr-workspace.js';

const base: PRReviewObservation = {
  observedAt: '2026-09-10T12:00:00.000Z',
  headSha: 'head2',
  state: 'open',
  draft: false,
  decision: 'REVIEW_REQUIRED',
  reviewer: 'me',
  requested: false,
  review: null,
};
const entry = (o?: Partial<PRReviewObservation>, status?: Partial<PRStatus>): PRWorkspaceEntry => ({
  key: { repo: 'org/repo', pr: 1 },
  title: 'PR',
  author: 'teammate',
  monitors: [],
  reviews: [],
  requests: [],
  reviewObservations: o ? [{ ...base, ...o }] : [],
  status: status ? ({ prState: 'OPEN', ...status } as PRStatus) : undefined,
});

test('the queue orders by what the viewer must do next', () => {
  const cr = { state: 'CHANGES_REQUESTED', commit: 'head1', submittedAt: null };
  assert.equal(prReviewQueue(entry({ review: cr })).group, 'Re-review: author pushed since');
  assert.equal(
    prReviewQueue(entry({ review: { ...cr, commit: 'head2' } })).group,
    'Waiting on author',
  );
  assert.equal(prReviewQueue(entry({ review: null })).group, 'Not reviewed yet');
  assert.equal(prReviewQueue(entry({ review: null, requested: true })).label, 'Review requested');
  assert.equal(
    prReviewQueue(entry({ review: { ...cr, commit: 'head2' }, requested: true })).group,
    'Re-review: author pushed since',
    'an explicit re-request beats an at-head verdict',
  );
});

test('PR approval does not hide an outstanding QA request', () => {
  const value = entry({ decision: 'APPROVED' });
  value.reviews = [
    {
      id: 'runtime-check',
      pr: { host: 'github.com', repo: 'org/repo', number: 1 },
      headSha: 'head2',
      reviewProfile: 'default',
      status: 'held',
      contributions: [
        {
          submissionId: 'qa-request',
          submissionRevision: 1,
          ownerId: 'owner',
          teamId: 'team',
          teamRevision: 1,
          reasons: [],
          eligible: true,
          autoStart: false,
          configurationErrors: [],
          review: { workflow: 'qa', sessionIntent: 'reset', scope: 'full' },
        },
      ],
      createdAt: base.observedAt,
      updatedAt: base.observedAt,
    },
  ];
  assert.equal(prReviewQueue(value).group, 'QA pending');
  value.reviews[0].status = 'running';
  assert.equal(prReviewQueue(value).group, 'QA in progress');
  value.reviews[0].status = 'completed';
  assert.equal(prReviewQueue(value).group, 'Reviewed by you');
});

test('approvals distinguish "done" from "others still required"', () => {
  const approved = { state: 'APPROVED', commit: 'head2', submittedAt: null };
  const done = prReviewQueue(entry({ review: approved, decision: 'APPROVED' }));
  assert.equal(done.group, 'Reviewed by you');
  assert.equal(done.label, 'Approved');
  const partial = prReviewQueue(entry({ review: approved, decision: 'REVIEW_REQUIRED' }));
  assert.equal(partial.label, 'Approved, others still required');
  const stale = prReviewQueue(entry({ review: { ...approved, commit: 'head1' } }));
  assert.equal(stale.group, 'Re-review: author pushed since');
  assert.equal(stale.label, 'New commits since your review');
  const staleButSatisfied = prReviewQueue(
    entry({ review: { ...approved, commit: 'head1' }, decision: 'APPROVED' }),
  );
  assert.equal(
    staleButSatisfied.group,
    'Reviewed by you',
    'satisfied requirements beat a moved head',
  );
  assert.match(staleButSatisfied.detail, /head moved/);
});

test('live PR state outranks a stale observation', () => {
  const merged = prReviewQueue(entry({ state: 'open', review: null }, { prState: 'MERGED' }));
  assert.equal(merged.group, 'Not ready');
  assert.equal(merged.label, 'Merged');
});

test('without an observation the overall GitHub decision decides, and says so', () => {
  assert.equal(
    prReviewQueue(entry(undefined, { reviewDecision: 'REVIEW_REQUIRED' })).group,
    'Not reviewed yet',
  );
  const cr = prReviewQueue(entry(undefined, { reviewDecision: 'CHANGES_REQUESTED' }));
  assert.equal(cr.group, 'Waiting on author');
  assert.match(cr.detail, /your own review status is unknown/);
  assert.equal(
    prReviewQueue(entry(undefined, { reviewDecision: '' })).group,
    'Review status unknown',
  );
  assert.equal(prReviewQueue(entry(undefined, { prState: 'MERGED' })).group, 'Not ready');
  assert.equal(prReviewQueue(entry({ draft: true })).label, 'Draft');
});

test('with two review accounts the most pressing one wins', () => {
  const e = entry({
    reviewer: 'bob',
    review: { state: 'APPROVED', commit: 'head2', submittedAt: null },
  });
  e.reviewObservations.push({
    ...base,
    reviewer: 'alice',
    requested: true,
    observedAt: '2026-09-10T11:59:00.000Z',
  });
  const item = prReviewQueue(e);
  assert.equal(item.group, 'Not reviewed yet');
  assert.match(item.detail, /@alice/);
});
