import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentContext, ReviewStatus } from '@farmslot/protocol';

import { makeRun } from '../run-engine/test-fixtures.js';

import { publicationGateStallReason, readReviewerLiveness } from './publication-gate-stall.js';

const started = Date.parse('2026-01-01T00:00:00Z');
const completedAt = new Date(started + 60_000).toISOString();
const review: ReviewStatus = {
  id: 'example-review',
  source: 'dispatch',
  mode: 'warm',
  runner: 'codex',
  model: null,
  reviewerSessionId: 'example-session',
  loopNumber: 1,
  verdict: 'pass',
  unresolvedCount: 0,
  completedAt,
  retryCount: 2,
};
const context: AgentContext = {
  id: 'example-reviewer',
  role: 'review',
  label: 'Reviewer',
  status: 'working',
  runId: 'example-run',
  slotId: 'example-slot',
  artifactScope: review.id,
  startedAt: new Date(started + 120_000).toISOString(),
};
function gate() {
  return makeRun({
    id: 'example-run',
    status: 'human-gating',
    slotId: context.slotId,
    steps: [{ name: 'human-gate', status: 'running', startedAt: new Date(started).toISOString() }],
    decisions: [],
    engineState: { publishGate: { reviews: [review] } },
  });
}

test('a saved verdict flags preparation strictly after ten minutes without mutating the run', async () => {
  const run = gate();
  const before = structuredClone(run);
  assert.equal(await publicationGateStallReason(run, started + 600_000), undefined);
  assert.match((await publicationGateStallReason(run, started + 600_001))!, /verdict is recorded/);
  assert.deepEqual(run, before);
});

test('a live warm retry excludes the earlier verdict; confirmed absence flags and unknown holds', async () => {
  const run = gate();
  run.agentContexts = [context];
  const now = started + 900_000;
  for (const state of ['present', 'unknown'] as const)
    assert.equal(await publicationGateStallReason(run, now, async () => state), undefined);
  assert.match(
    (await publicationGateStallReason(run, now, async () => 'absent'))!,
    /no live reviewer/,
  );
  run.agentContexts = [{ ...context, status: 'complete', completedAt }];
  assert.match((await publicationGateStallReason(run, now))!, /verdict is recorded/);
});

test('a pending gate review with no context flags; operator waits and finished or paused gates do not', async () => {
  const run = gate();
  const now = started + 900_000;
  run.engineState!.publishGate!.reviews = [
    { ...review, verdict: 'pending', completedAt: undefined },
  ];
  assert.match((await publicationGateStallReason(run, now))!, /no live reviewer/);
  for (const status of ['done', 'cancelled', 'failed', 'paused'] as const)
    assert.equal(await publicationGateStallReason({ ...run, status }, now), undefined);
  run.steps[0].status = 'done';
  assert.equal(await publicationGateStallReason(run, now), undefined);
  run.steps[0].status = 'running';
  run.decisions = [
    {
      id: 'operator-card',
      type: 'engine_human_gate',
      title: 'Gate',
      description: '',
      actions: [],
      createdAt: completedAt,
    },
  ];
  assert.equal(await publicationGateStallReason(run, now), undefined);
});

test('a worker-fix continuation and a gate with no review requirement are legitimate waits', async () => {
  const run = gate();
  run.engineState!.publishGate!.reviews = [];
  assert.equal(await publicationGateStallReason(run, started + 900_000), undefined);
  run.agentContexts = [{ ...context, role: 'review-fix' }];
  run.engineState!.publishGate!.reviews = [{ ...review, verdict: 'pending' }];
  assert.equal(await publicationGateStallReason(run, started + 900_000), undefined);
});

test('an earlier row cannot flag a live second reviewer or its worker-fix phase', async () => {
  const run = gate();
  const now = started + 900_000;
  run.agentContexts = [{ ...context, artifactScope: 'second-review', reviewId: 'second-lineage' }];
  assert.equal(await publicationGateStallReason(run, now, async () => 'present'), undefined);
  assert.equal(await publicationGateStallReason(run, now, async () => 'unknown'), undefined);
  assert.match(
    (await publicationGateStallReason(run, now, async () => 'absent'))!,
    /no live reviewer/,
  );
  run.agentContexts = [{ ...context, role: 'review-fix' }];
  assert.equal(await publicationGateStallReason(run, now), undefined);
});

test('an active reviewer with missing process identity has unknown liveness', async () => {
  const run = gate();
  assert.equal(await readReviewerLiveness(run, context), 'unknown');
  assert.equal(await readReviewerLiveness({ ...run, slotId: null }, context), 'unknown');
});
