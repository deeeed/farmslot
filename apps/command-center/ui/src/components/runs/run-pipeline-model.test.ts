import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  computeLayout,
  effectiveTaskProgressForRun,
  publicationReviewStepForName,
} from './run-pipeline-model.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'monitoring',
    project: 'farmslot-farm',
    ticketOrPr: 'BUG-123',
    slotId: 'slot-1',
    branch: 'feature/run-pipeline',
    taskFile: '/tmp/TASK.md',
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5.4' },
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z',
    ...overrides,
  };
}

test('computeLayout inserts publication review plan nodes without mutating host state', () => {
  const baseRun = makeRun({
    steps: [
      { name: 'find-slot', status: 'done' },
      { name: 'self-review', status: 'done' },
      { name: 'complete', status: 'pending' },
      { name: 'human-gate', status: 'pending' },
    ],
    engineState: {
      publishGate: {
        reviewDepth: {
          requestedBy: 'dispatch',
          minimumIndependentReviews: 1,
          requireCrossRunner: false,
          extraLoopsRequested: 0,
        },
        pendingReviewPlan: [
          { order: 1, runner: 'claude', model: 'opus', validationDepth: 'full-live' },
        ],
      },
    },
  });

  const layout = computeLayout(baseRun);
  assert.ok(layout.nodes.some((node) => node.id === 'pre-gate-publication-review-1'));
  assert.ok(layout.arrows.length > 0);

  const reviewStep = publicationReviewStepForName(baseRun, 'pre-gate-publication-review-1');
  assert.equal(reviewStep?.status, 'pending');
  assert.equal(reviewStep?.detail, 'claude / opus');

  const ciRun = {
    ...baseRun,
    status: 'ci-watching',
    steps: [
      {
        name: 'ci-watch',
        status: 'running',
        outputs: {
          phase: 'fixing',
          fixInProgress: true,
          fixProgress: { total: 3, completed: 1, currentLabel: 'Patch' },
        },
      },
    ],
  } as Run;
  const progress = effectiveTaskProgressForRun(ciRun, undefined);
  assert.equal(progress?.totalSteps, 3);
  assert.equal(progress?.completedSteps, 1);
  assert.equal(progress?.currentStep, 'Patch');
});

test('computeLayout places post-gate review nodes after the worker lane to avoid overlap', () => {
  const run = makeRun({
    status: 'blocked',
    steps: [
      { name: 'find-slot', status: 'done' },
      { name: 'write-task', status: 'done' },
      { name: 'prepare', status: 'done' },
      { name: 'dispatch', status: 'done' },
      { name: 'monitor', status: 'done' },
      { name: 'self-review', status: 'done' },
      { name: 'complete', status: 'done' },
      { name: 'human-gate', status: 'running' },
      { name: 'finalize', status: 'pending' },
      { name: 'ci-watch', status: 'pending' },
      { name: 'done', status: 'pending' },
    ],
    engineState: {
      publishGate: {
        reviewDepth: {
          requestedBy: 'human-gate',
          minimumIndependentReviews: 1,
          requireCrossRunner: true,
          extraLoopsRequested: 1,
        },
        independentReviews: [
          {
            id: 'independent-review-2',
            source: 'human-gate',
            runner: 'codex',
            crossRunner: true,
            loopNumber: 2,
            verdict: 'failed',
            unresolvedCount: 0,
            validationDepth: 'static-code',
            completedAt: '2026-05-14T00:00:30.000Z',
          },
          {
            id: 'independent-review-3',
            source: 'human-gate',
            runner: 'claude',
            crossRunner: true,
            loopNumber: 3,
            verdict: 'pass',
            unresolvedCount: 0,
            validationDepth: 'static-code',
            completedAt: '2026-05-14T00:01:00.000Z',
          },
        ],
      },
    },
  });

  const layout = computeLayout(run);
  const selfReview = layout.nodes.find((node) => node.id === 'self-review');
  const postGateReview = layout.nodes.find((node) => node.id === 'post-gate-publication-review-1');
  const packageRefresh = layout.nodes.find((node) => node.id === 'package-refresh');
  const finalize = layout.nodes.find((node) => node.id === 'finalize');
  assert.ok(selfReview);
  assert.ok(postGateReview);
  assert.ok(packageRefresh);
  assert.ok(finalize);
  assert.equal(packageRefresh.step.status, 'done');
  assert.ok(postGateReview.x > selfReview.x + selfReview.w);
  assert.ok(packageRefresh.x > postGateReview.x + postGateReview.w);
  assert.ok(finalize.x > packageRefresh.x + packageRefresh.w);
});
