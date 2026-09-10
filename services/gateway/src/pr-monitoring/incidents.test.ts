import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRMonitorObservation, PRMonitorSignal } from '@farmslot/protocol';

import { reconcilePRMonitorIncidents } from './incidents.js';

const review: PRMonitorSignal = {
  kind: 'review',
  key: 'review-1',
  revision: 'review-1-submitted',
  summary: 'Changes requested',
  url: 'https://github.com/owner/repo/pull/1#review-1',
};
const observed: PRMonitorObservation = {
  checkedAt: '2026-09-09T12:00:00.000Z',
  headSha: 'head-a',
  title: 'PR',
  author: 'author',
  state: 'open',
  draft: false,
  mergeability: 'mergeable',
  reviewDecision: 'changes-requested',
  signals: [review],
};

test('an unchanged review stays one incident across new heads, acknowledgement and attempts', () => {
  const first = reconcilePRMonitorIncidents([], observed);
  first[0].acknowledgedAt = observed.checkedAt;
  first[0].attemptCount = 2;
  first[0].handledAt = observed.checkedAt;
  const next = reconcilePRMonitorIncidents(first, {
    ...observed,
    headSha: 'head-b',
    checkedAt: '2026-09-10T12:00:00.000Z',
  });
  assert.equal(next.length, 1);
  assert.equal(next[0].attemptCount, 2);
  assert.equal(next[0].handledAt, observed.checkedAt);
  assert.equal(next[0].resolvedAt, undefined);
  assert.equal(first[0].lastObservedAt, observed.checkedAt);
});

test('revised feedback supersedes the previous incident and starts a new attempt budget', () => {
  const first = reconcilePRMonitorIncidents([], observed);
  first[0].attemptCount = 2;
  const next = reconcilePRMonitorIncidents(first, {
    ...observed,
    signals: [{ ...review, revision: 'edited' }],
  });
  assert.equal(next.length, 2);
  assert.equal(next[0].resolvedAt, observed.checkedAt);
  assert.equal(next[1].attemptCount, 0);
  assert.notEqual(next[0].id, next[1].id);
});

test('unknown mergeability preserves conflicts, confirmed resolution and closure clear them', () => {
  const conflict = { ...review, kind: 'conflict' as const, key: 'conflict', revision: 'base-head' };
  const first = reconcilePRMonitorIncidents([], {
    ...observed,
    mergeability: 'conflicting',
    signals: [conflict],
  });
  assert.equal(
    reconcilePRMonitorIncidents(first, { ...observed, mergeability: 'unknown', signals: [] })[0]
      .resolvedAt,
    undefined,
  );
  assert.equal(
    reconcilePRMonitorIncidents(first, { ...observed, signals: [] })[0].resolvedAt,
    observed.checkedAt,
  );
  assert.equal(
    reconcilePRMonitorIncidents(first, {
      ...observed,
      state: 'merged',
      mergeability: 'unknown',
      signals: [],
    })[0].resolvedAt,
    observed.checkedAt,
  );
});

test('a watched check missing from an observation stays unknown instead of resolving its failure', () => {
  const signal = { ...review, kind: 'check' as const, key: 'check-1', checkName: 'unit' };
  const first = reconcilePRMonitorIncidents([], { ...observed, signals: [signal] });
  const next = reconcilePRMonitorIncidents(first, {
    ...observed,
    signals: [],
    checks: [{ key: 'watched:unit', name: 'unit', status: 'unknown', url: review.url }],
  });
  assert.equal(next[0].resolvedAt, undefined);
});

test('successive failing check attempts retain their repair budget through pending heads until a confirmed pass', () => {
  const signal = { ...review, kind: 'check' as const, key: 'attempt-a', checkName: 'unit' };
  const first = reconcilePRMonitorIncidents([], { ...observed, signals: [signal] });
  first[0].attemptCount = 2;
  first[0].lastAttemptAt = observed.checkedAt;
  const pending = reconcilePRMonitorIncidents(first, {
    ...observed,
    headSha: 'repair-head',
    signals: [],
    checks: [{ key: 'attempt-b', name: 'unit', status: 'pending', url: review.url }],
  });
  const failed = reconcilePRMonitorIncidents(pending, {
    ...observed,
    headSha: 'repair-head',
    signals: [{ ...signal, key: 'attempt-b', revision: 'new-failure' }],
  });
  assert.notEqual(failed[1].id, first[0].id, 'New attempts remain distinct evidence');
  assert.equal(failed[1].attemptCount, 2, 'Own pushes cannot reset automatic attempts');
  assert.equal(failed[1].lastAttemptAt, first[0].lastAttemptAt);
  const passed = reconcilePRMonitorIncidents(failed, {
    ...observed,
    signals: [],
    checks: [{ key: 'attempt-b', name: 'unit', status: 'passed', url: review.url }],
  });
  const laterFailure = reconcilePRMonitorIncidents(passed, {
    ...observed,
    headSha: 'external-head',
    signals: [{ ...signal, key: 'attempt-c', revision: 'later-failure' }],
  });
  assert.equal(
    laterFailure.at(-1)?.attemptCount,
    0,
    'A failure after confirmed recovery starts a new budget',
  );
});
