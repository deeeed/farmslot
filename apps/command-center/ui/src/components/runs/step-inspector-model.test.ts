import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { Run, RunStep } from '@farmslot/protocol';

import { GATEWAY_TOKEN_STORAGE_KEY } from '../../gateway-url.js';

import {
  extractStepCostInfo,
  isFreshDispatchRecovery,
  reviewRequestHref,
  stepArtifactsForRunStep,
  stepArtifactUrl,
  stepDurationLabel,
  stepQueueTimingRows,
} from './step-inspector-model.js';

test('static review recovery points to the existing PR request interface', () => {
  const run = {
    ticketOrPr: 'https://github.com/example/repo/pull/42',
    reviewWorkspaceTarget: { machine: 'local' },
  } as Run;
  const href = reviewRequestHref(run);
  assert.ok(href);
  const params = new URLSearchParams(href.split('?')[1]);
  assert.equal(params.get('repo'), 'example/repo');
  assert.equal(params.get('pr'), '42');
  assert.equal(params.get('prPane'), 'review');
  assert.equal(reviewRequestHref({ ...run, reviewWorkspaceTarget: undefined }), null);
});

test('retained handoff failure requires an explicit fresh dispatch replay', () => {
  const run = {
    error:
      'Retained session handoff requires operator attention: exact prompt acknowledgement missing',
  } as Run;
  assert.equal(isFreshDispatchRecovery(run, 'dispatch'), true);
  assert.equal(isFreshDispatchRecovery(run, 'monitor'), false);
  assert.equal(isFreshDispatchRecovery({ ...run, error: 'other failure' }, 'dispatch'), false);
});

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

test('the inspector shows queued, executing and last-progress rows when there is something to say', () => {
  const run = {
    createdAt: '2026-06-01T00:00:00.000Z',
    steps: [{ name: 'find-slot', status: 'done' }],
  } as unknown as Run;
  const nowMs = Date.parse('2026-06-01T00:06:00.000Z');
  const prepare = {
    name: 'prepare',
    status: 'running',
    startedAt: '2026-06-01T00:00:00.000Z',
    queuedMs: 60_000,
    lastProgressAt: '2026-06-01T00:05:20.000Z',
  } as RunStep;
  assert.deepEqual(stepQueueTimingRows(run, prepare, nowMs), [
    ['Queued', '1m 0s'],
    ['Executing', '5m 0s'],
    ['Last progress', '40s ago'],
  ]);
  assert.deepEqual(
    stepQueueTimingRows(run, { name: 'dispatch', status: 'done', durationMs: 5_000 }, nowMs),
    [],
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
