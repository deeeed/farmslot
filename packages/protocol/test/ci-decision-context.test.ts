import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRCheckSnapshot, PRStatus } from '../src/contracts/reviews.js';
import type { RunDecision } from '../src/contracts/runs.js';
import {
  CI_DECISION_TYPES,
  ciDecisionCheckView,
  ciDecisionSnapshotContext,
  normalizeCICheckDetail,
} from '../src/runs/ci-decision-context.js';

const now = Date.parse('2026-10-12T12:00:00Z');
const snapshot: PRCheckSnapshot = {
  pr: 42,
  repo: 'owner/repo',
  fetchedAt: '2026-10-12T11:58:00Z',
  checks: [
    normalizeCICheckDetail({
      name: 'gateway',
      state: 'IN_PROGRESS',
      startedAt: '2026-10-12T11:55:00Z',
      completedAt: '0001-01-01T00:00:00Z',
      detailsUrl: 'https://github.com/owner/repo/actions/runs/1',
    }),
  ],
};
const current = {
  pr: 42,
  repo: 'owner/repo',
  checkSnapshot: {
    ...snapshot,
    fetchedAt: '2026-10-12T11:59:55Z',
    checks: [
      normalizeCICheckDetail({
        name: 'gateway',
        state: 'SUCCESS',
        completedAt: '2026-10-12T11:59:30Z',
        detailsUrl: 'https://github.com/owner/repo/actions/runs/2',
      }),
    ],
  },
} as PRStatus;
const decision = { type: 'ci_ci_timeout', context: { checkSnapshot: snapshot } } as RunDecision;

for (const type of CI_DECISION_TYPES) {
  test(`${type} compares frozen and current metadata without changing the decision`, () => {
    const gate = { ...decision, type };
    const before = structuredClone(gate);
    const view = ciDecisionCheckView({ decision: gate, current, currentState: 'ready', now })!;
    assert.equal(view.snapshot.label, 'Gate snapshot');
    assert.equal(view.current?.label, 'Current PR checks');
    assert.equal(view.snapshot.rows[0].status, 'IN_PROGRESS');
    assert.equal(view.snapshot.rows[0].conclusion, 'Not recorded');
    assert.equal(view.snapshot.rows[0].age, '5m ago');
    assert.equal(view.snapshot.age, '2m ago');
    assert.equal(view.current?.rows[0].status, 'COMPLETED');
    assert.equal(view.current?.rows[0].conclusion, 'SUCCESS');
    assert.equal(view.current?.rows[0].age, '30s ago');
    assert.equal(view.current?.age, '5s ago');
    assert.match(view.current!.rows[0].detailsUrl!, /runs\/2$/);
    assert.deepEqual(gate, before);
  });
}

test('legacy watched checks never borrow current conclusions, ages or links', () => {
  const view = ciDecisionCheckView({
    decision: { ...decision, context: { checks: [{ name: 'gateway', status: 'pending' }] } },
    current,
    currentState: 'ready',
    now,
  })!;
  assert.deepEqual(view.snapshot.rows[0], {
    name: 'gateway',
    status: 'pending',
    conclusion: 'Not recorded',
    age: 'Not recorded',
    detailsUrl: null,
  });
  assert.match(view.snapshot.note, /not recorded/);
  assert.equal(view.current?.rows[0].conclusion, 'SUCCESS');
});

test('missing, trimmed, loading, unavailable and genuinely empty reads remain distinct', () => {
  const missing = { ...decision, context: {} };
  assert.equal(
    ciDecisionCheckView({ decision: missing, currentState: 'loading' })?.snapshot.state,
    'missing',
  );
  assert.equal(
    ciDecisionCheckView({
      decision: { ...missing, payloadTrimmed: ['context.checkSnapshot'] },
      currentState: 'loading',
    })?.snapshot.state,
    'loading',
  );
  assert.equal(
    ciDecisionCheckView({ decision, currentState: 'loading' })?.current?.state,
    'loading',
  );
  assert.equal(
    ciDecisionCheckView({
      decision,
      current: { ...current, checkSnapshot: undefined },
      currentState: 'ready',
    })?.current?.state,
    'unavailable',
  );
  const empty = ciDecisionCheckView({
    decision,
    current: { ...current, checkSnapshot: { ...current.checkSnapshot!, checks: [] } },
    currentState: 'ready',
  })!;
  assert.equal(empty.current?.state, 'available');
  assert.deepEqual(empty.current?.rows, []);
  assert.equal(ciDecisionCheckView({ decision, currentState: 'not-requested' })?.current, null);
});

test('refresh and errors keep snapshot and previous current checks visible', () => {
  for (const currentState of ['loading', 'error'] as const) {
    const view = ciDecisionCheckView({ decision, current, currentState, now })!;
    assert.equal(view.snapshot.rows[0].status, 'IN_PROGRESS');
    assert.equal(view.current?.rows[0].conclusion, 'SUCCESS');
    if (currentState === 'error') assert.match(view.current!.note, /Refresh failed/);
  }
});

test('current checks for a different PR or repository are refused', () => {
  for (const bad of [
    { ...current, pr: 43 },
    { ...current, repo: 'owner/other' },
    { ...current, checkSnapshot: { ...snapshot, pr: 43 } },
  ]) {
    assert.equal(
      ciDecisionCheckView({ decision, current: bad, currentState: 'ready' })?.current?.state,
      'unavailable',
    );
  }
  assert.equal(
    ciDecisionCheckView({
      decision,
      current: { ...current, repo: 'OWNER/REPO' },
      currentState: 'ready',
    })?.current?.state,
    'available',
  );
});

test('normalization preserves terminal conclusions and uses source activity, not duration', () => {
  const zero = '0001-01-01T00:00:00Z';
  for (const state of ['FAILURE', 'CANCELLED', 'SKIPPED', 'NEUTRAL', 'TIMED_OUT', 'ERROR']) {
    const row = normalizeCICheckDetail({ name: 'unit', state, startedAt: zero, completedAt: zero });
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.conclusion, state);
    assert.equal(row.timestamp, null);
    assert.equal(row.detailsUrl, null);
  }
  assert.equal(
    normalizeCICheckDetail({ name: 'legacy', state: 'PENDING', startedAt: snapshot.fetchedAt })
      .timestamp,
    snapshot.fetchedAt,
  );
});

test('snapshot capture clones rows and freezes identity even when metadata is unavailable', () => {
  const source = structuredClone(current);
  const captured = ciDecisionSnapshotContext(source);
  source.checkSnapshot!.checks[0].conclusion = 'FAILURE';
  assert.equal((captured.checkSnapshot as PRCheckSnapshot).checks[0].conclusion, 'SUCCESS');
  assert.deepEqual(ciDecisionSnapshotContext({ ...source, checkSnapshot: undefined }), {
    prNumber: 42,
    repo: 'owner/repo',
  });
  assert.equal(
    ciDecisionCheckView({ decision: { type: 'engine_human_gate' }, currentState: 'ready' }),
    null,
  );
});
