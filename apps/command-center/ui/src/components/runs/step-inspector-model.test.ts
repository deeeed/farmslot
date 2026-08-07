import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { Run, RunStep } from '@farmslot/protocol';

import { GATEWAY_TOKEN_STORAGE_KEY } from '../../gateway-url.js';

import {
  extractStepCostInfo,
  reviewLoopAttempts,
  stepArtifactsForRunStep,
  stepArtifactUrl,
  stepDurationLabel,
  stepHasReviewLoop,
} from './step-inspector-model.js';

test('stepDurationLabel formats completed and running step durations', () => {
  assert.equal(stepDurationLabel({ durationMs: 90_000 } as RunStep, Date.now()), '1m 30s');
  assert.equal(
    stepDurationLabel(
      { status: 'running', startedAt: '2026-06-01T00:00:00.000Z' } as RunStep,
      Date.parse('2026-06-01T00:01:30.000Z'),
    ),
    'elapsed 1m 30s',
  );
});

test('extractStepCostInfo preserves direct, llm, and run-level cost shapes', () => {
  assert.deepEqual(
    extractStepCostInfo({
      name: 'grade',
      status: 'done',
      outputs: {
        costUsd: 1.25,
        session: { inputTokens: 1000, outputTokens: 250, model: 'sonnet', numTurns: 3 },
      },
    } as RunStep),
    { cost: '$1.25', tokens: '1,000 in / 250 out', model: 'sonnet', extra: '3 turns' },
  );
  assert.deepEqual(
    extractStepCostInfo({
      name: 'grade',
      status: 'done',
      outputs: { llm: { costUsd: 0.0123, inputTokens: 11, outputTokens: 22, model: 'mini' } },
    } as RunStep),
    { cost: '$0.0123', tokens: '11 in / 22 out', model: 'mini' },
  );
  assert.deepEqual(
    extractStepCostInfo(
      { name: 'complete', status: 'done', outputs: {} } as RunStep,
      { metrics: { costEstimate: 2.5, model: 'opus' } } as Run,
    ),
    { cost: '$2.50', model: 'opus' },
  );
});

test('stepArtifactsForRunStep normalizes typed artifacts and drops malformed rows', () => {
  assert.deepEqual(
    stepArtifactsForRunStep(
      {
        name: 'verify',
        status: 'done',
        outputs: {
          artifacts: [
            { path: 'artifacts/after.png', purpose: 'screenshot', sizeBytes: 123 },
            { purpose: 'missing-path' },
          ],
        },
      } as RunStep,
      { id: 'run-1', familyId: 'family-1' } as Run,
    ),
    [
      {
        runId: 'run-1',
        familyId: 'family-1',
        stepName: 'verify',
        path: 'artifacts/after.png',
        purpose: 'screenshot',
        sizeBytes: 123,
        source: 'step-output',
      },
    ],
  );
});

test('stepHasReviewLoop gates the loop panel to review steps with attempts', () => {
  const selfReviewOutputs = {
    verdict: 'pass',
    attempts: [{ loopNumber: 1, verdict: 'issues', unresolvedCount: 8 }],
  };
  assert.equal(
    stepHasReviewLoop({
      name: 'self-review',
      status: 'done',
      outputs: selfReviewOutputs,
    } as RunStep),
    true,
  );
  assert.equal(
    stepHasReviewLoop({
      name: 'publication-review-1',
      status: 'done',
      outputs: { timeline: [{ kind: 'review' }] },
    } as RunStep),
    true,
  );
  // self-review with no loop data should not render the panel
  assert.equal(
    stepHasReviewLoop({ name: 'self-review', status: 'running', outputs: {} } as RunStep),
    false,
  );
  // unrelated steps never render the panel
  assert.equal(
    stepHasReviewLoop({
      name: 'verify',
      status: 'done',
      outputs: { attempts: [{ loopNumber: 1 }] },
    } as RunStep),
    false,
  );
  // self-review with an empty attempts array (and no timeline) does not render
  assert.equal(
    stepHasReviewLoop({
      name: 'self-review',
      status: 'done',
      outputs: { attempts: [] },
    } as RunStep),
    false,
  );
});

test('reviewLoopAttempts normalizes self-review loop convergence', () => {
  const step = {
    name: 'self-review',
    status: 'done',
    outputs: {
      verdict: 'pass',
      attempts: [
        {
          loopNumber: 1,
          verdict: 'issues',
          unresolvedCount: 8,
          completedAt: '2026-05-24T08:59:22.694Z',
          issues: [
            { file: 'a.ts', line: 341, description: 'swallows errors' },
            { file: 'b.tsx', description: 'untested path' },
          ],
        },
        {
          loopNumber: 2,
          verdict: 'issues',
          unresolvedCount: 1,
          fixDelta: {
            baseSha: 'base-sha',
            headSha: 'head-sha',
            diffPath: 'artifacts/review-loop-2/fix-delta.diff',
          },
        },
        { loopNumber: 3, verdict: 'issues', unresolvedCount: 4 },
        { loopNumber: 4, verdict: 'pass', unresolvedCount: 0 },
      ],
    },
  } as RunStep;

  const attempts = reviewLoopAttempts(step);
  // The self-review loop converges 8 -> 1 -> 4 -> 0 across four passes.
  assert.deepEqual(
    attempts.map((a) => [a.loopNumber, a.verdict, a.unresolvedCount]),
    [
      [1, 'issues', 8],
      [2, 'issues', 1],
      [3, 'issues', 4],
      [4, 'pass', 0],
    ],
  );
  assert.deepEqual(attempts[0].issues, [
    { file: 'a.ts', line: 341, description: 'swallows errors' },
    { file: 'b.tsx', line: undefined, description: 'untested path' },
  ]);
  assert.equal(attempts[1].hasFixDelta, true);
  assert.equal(attempts[1].fixDeltaPath, 'artifacts/review-loop-2/fix-delta.diff');
  assert.equal(attempts[0].hasFixDelta, false);
  assert.equal(attempts[0].fixDeltaPath, null);
});

test('reviewLoopAttempts does not call an unavailable snapshot a worker fix', () => {
  const step = {
    name: 'self-review',
    status: 'done',
    outputs: {
      attempts: [
        { loopNumber: 2, verdict: 'pass', unresolvedCount: 0, fixDelta: { source: 'unavailable' } },
      ],
    },
  } as RunStep;
  const attempt = reviewLoopAttempts(step)[0];
  assert.equal(attempt.hasFixDelta, false);
  assert.equal(attempt.fixDeltaPath, null);
});

test('reviewLoopAttempts returns [] for missing or non-array attempts', () => {
  assert.deepEqual(
    reviewLoopAttempts({ name: 'self-review', status: 'running', outputs: {} } as RunStep),
    [],
  );
  assert.deepEqual(
    reviewLoopAttempts({
      name: 'self-review',
      status: 'done',
      outputs: { attempts: 'nope' },
    } as unknown as RunStep),
    [],
  );
});

test('reviewLoopAttempts falls back to index-based loop numbers', () => {
  const step = {
    name: 'self-review',
    status: 'done',
    outputs: { attempts: [{ verdict: 'pass' }, {}] },
  } as RunStep;
  const attempts = reviewLoopAttempts(step);
  assert.deepEqual(
    attempts.map((a) => [a.loopNumber, a.verdict, a.unresolvedCount]),
    [
      [1, 'pass', 0],
      [2, 'pending', 0],
    ],
  );
});

test('stepArtifactUrl encodes run artifact paths', () => {
  withMockLocalStorage(() => {
    localStorage.setItem(GATEWAY_TOKEN_STORAGE_KEY, 'dev-token');
    const url = stepArtifactUrl({
      runId: 'run-1',
      familyId: 'family-1',
      stepName: 'verify',
      path: 'artifacts/a b.png',
      purpose: 'screenshot',
      source: 'step-output',
    });
    assert.match(url, /runId=run-1/);
    assert.match(url, /path=artifacts(%2F|%252F)a(\+|%20|%2520)b\.png/);
    assert.match(url, /token=dev-token/);
  });
});

function withMockLocalStorage(fn: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        store.set(key, value);
      },
      removeItem(key: string): void {
        store.delete(key);
      },
    },
  });
  try {
    fn();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, 'localStorage', previous);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
}
