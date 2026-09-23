import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AssessmentResult } from '@farmslot/protocol';

import { finishAssessment, reserveAssessment } from '../../assessment/store.js';

import { priceTriageResult } from './service.js';

const result: AssessmentResult = {
  status: 'completed',
  attempted: true,
  provider: 'typesafe',
  requestedModel: 'jev-fixture',
  returnedModel: 'jev-fixture',
  answers: { cause: { type: 'choice', choice: 'environment', choices: ['environment'] } },
  usage: {
    provider: 'typesafe',
    requestedModel: 'jev-fixture',
    inputTokens: 120,
    outputTokens: 20,
    cacheReadTokens: 10,
    durationMs: 8,
    requestId: 'receipt-1',
  },
};

test('over-bound reply remains unavailable while retaining attempted usage and estimated charge', () => {
  const priced = priceTriageResult(result, { inputUsdPerMillion: 1, maxRequestTokens: 100 });
  assert.equal(priced.status, 'unavailable');
  assert.equal(priced.error, 'spend-bound-exceeded');
  assert.equal(priced.attempted, true);
  assert.equal(priced.answers, undefined);
  assert.deepEqual(priced.usage, {
    ...result.usage,
    costUsd: 0.00012,
    costKind: 'estimated',
  });
  assert.equal(result.usage?.costUsd, undefined);
});

test('reply within the bound keeps its answer and known accounting', () => {
  const priced = priceTriageResult(result, { inputUsdPerMillion: 1, maxRequestTokens: 120 });
  assert.equal(priced.status, 'completed');
  assert.deepEqual(priced.answers, result.answers);
  assert.equal(priced.usage?.inputTokens, 120);
  assert.equal(priced.usage?.costUsd, 0.00012);
});

test('rejected reply still enforces the input bound and retains known cost', () => {
  const rejected = { ...result, status: 'unavailable' as const, answers: undefined };
  const priced = priceTriageResult(rejected, { inputUsdPerMillion: 1, maxRequestTokens: 100 });
  assert.equal(priced.error, 'spend-bound-exceeded');
  assert.equal(priced.usage?.inputTokens, 120);
  assert.equal(priced.usage?.costUsd, 0.00012);
});

test('mismatched model retains tokens and the bound but leaves its charge unknown', () => {
  const mismatch = { ...result, returnedModel: 'other-model', answers: undefined };
  const bounded = priceTriageResult(
    mismatch,
    { inputUsdPerMillion: 1, maxRequestTokens: 100 },
    false,
  );
  assert.equal(bounded.status, 'unavailable');
  assert.equal(bounded.error, 'spend-bound-exceeded');
  assert.equal(bounded.usage?.inputTokens, 120);
  assert.equal(bounded.usage?.costUsd, undefined);
  assert.equal(bounded.usage?.costKind, undefined);
});

test('persisted over-bound reply locks out later calls under the same price snapshot', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'triage-bound-'));
  const prior = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  try {
    const context = {
      ownerId: 'operator-test',
      consumer: 'failure-triage' as const,
      subject: {
        run: { id: 'run-test', project: 'fixture', step: 'validate', snapshotHash: 'a'.repeat(64) },
      },
      policyVersion: 'failure-triage-v1',
    };
    const reservation = { key: 'b'.repeat(64), priceHash: 'c'.repeat(64), maxUsd: 0.01 };
    const first = await reserveAssessment(context, reservation, { maxCalls: 2, maxUsd: 0.02 });
    assert.equal(first.status, 'reserved');
    if (first.status !== 'reserved') throw new Error('Missing fixture reservation');
    await finishAssessment(
      first.record,
      priceTriageResult(result, { inputUsdPerMillion: 1, maxRequestTokens: 100 }),
    );
    const next = await reserveAssessment(
      context,
      { ...reservation, key: 'd'.repeat(64) },
      { maxCalls: 2, maxUsd: 0.02 },
    );
    assert.deepEqual(next, { status: 'budget-blocked', cause: 'spend-bound' });
  } finally {
    if (prior === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = prior;
    await rm(home, { recursive: true });
  }
});
