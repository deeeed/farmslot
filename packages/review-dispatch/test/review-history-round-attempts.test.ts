import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewHistoryIdentity, reviewHistoryView } from '../src/review-history.js';

import { reviewHistoryBdcbd42f } from './fixtures/review-history-bdcbd42f.js';

test('bdcbd42f shows one review with its two launch attempts and original findings, then its fix', () => {
  const run = structuredClone(reviewHistoryBdcbd42f);
  const before = structuredClone(run);
  const history = reviewHistoryView(run, {}, []);
  assert.deepEqual(run, before, 'projection must not rewrite retained receipts');
  assert.equal(history.roundCount, 1);
  const round = history.checks[0].rounds[0];
  assert.equal(round.roundNumber, 1);
  assert.equal(round.findings.length, 2);
  assert.equal(round.unresolvedCount, 2);
  assert.equal(round.verdict, 'issues');
  assert.deepEqual(
    round.earlierAttempts.map((entry) => [entry.status, entry.startedAt]),
    [
      ['failed', '2026-11-18T03:10:39.158Z'],
      ['failed', '2026-11-18T03:12:12.252Z'],
    ],
  );
  assert.equal(round.startedAt, '2026-11-18T03:23:00.914Z');
  assert.equal(round.completedAt, '2026-11-18T03:34:03.592Z');
  assert.deepEqual(
    history.events.map((event) => event.kind),
    ['review', 'fix'],
  );
  const fix = history.events.find((event) => event.kind === 'fix');
  assert.equal(fix?.fix.label, 'Fix after round 1');
  assert.equal(fix?.roundKey, round.key);
  assert.equal(fix?.fix.startedAt, '2026-11-18T03:34:08.690Z');
  assert.equal(fix?.fix.completedAt, '2026-11-18T03:41:58.252Z');
  assert.equal(fix?.fix.durationMs, 469562);
  assert.equal(history.cards.length, 1);
  assert.equal(history.cards[0].totalDurationMs, 1132240);
});

test('a real re-review after fix acceptance is round 2, including when its charged loop is reused', () => {
  const run = structuredClone(reviewHistoryBdcbd42f);
  const reviews = run.engineState?.publishGate?.reviews;
  assert(reviews?.[0].attempts);
  const actor = run.agentContexts?.find(
    (entry) => entry.status === 'complete' && entry.role === 'review',
  );
  assert(actor);
  const startedAt = '2026-11-18T03:43:00.000Z';
  const completedAt = '2026-11-18T03:45:00.000Z';
  run.agentContexts?.push({
    ...actor,
    id: 'actual-rereview',
    reviewLoopNumber: 2,
    startedAt,
    attemptStartedAt: startedAt,
    completedAt,
  });
  reviews[0].attempts.push({
    loopNumber: 2,
    mode: 'warm',
    verdict: 'pass',
    issues: [],
    unresolvedCount: 0,
    startedAt,
    completedAt,
  });
  const history = reviewHistoryView(run);
  assert.equal(history.roundCount, 2);
  assert.deepEqual(
    history.checks[0].rounds.map((round) => [
      round.roundNumber,
      round.verdict,
      round.findings.length,
    ]),
    [
      [1, 'issues', 2],
      [2, 'pass', 0],
    ],
  );
  assert.equal(history.cards[0].fixes.length, 1);
  assert.equal(history.cards[1].fixes.length, 0);
});

test('recorded startup reasons remain attached to each failed attempt and invalidate the history read', () => {
  const run = structuredClone(reviewHistoryBdcbd42f);
  const first = run.agentContexts?.[0];
  assert(first);
  const identity = reviewHistoryIdentity(run);
  first.error = 'Native-host version mismatch';
  assert.notEqual(reviewHistoryIdentity(run), identity);
  assert.equal(
    reviewHistoryView(run).checks[0].rounds[0].earlierAttempts[0].failureReason,
    first.error,
  );
});
