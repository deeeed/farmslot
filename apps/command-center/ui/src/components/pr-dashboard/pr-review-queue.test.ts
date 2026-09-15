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
