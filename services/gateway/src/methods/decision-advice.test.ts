import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AssessmentResult } from '@farmslot/protocol';

import { beginAssessment, finishAssessment } from '../assessment/store.js';
import { createRun, deleteRun, updateRun } from '../runs/store.js';
import { runWithSessionOriginator } from '../security/work-originator.js';

import {
  decisionAdviceAnalyze,
  decisionAdviceGet,
  estimateDecisionAdviceCost,
  validateDecisionAdviceResponse,
} from './decision-advice.js';

const principal = {
  id: 'decision-advice-test',
  subject: { type: 'person' as const, displayName: 'Tester' },
  roles: [],
};
const withPrincipal = <T>(operation: () => T) => runWithSessionOriginator(principal, operation);
const makeDecision = () => ({
  id: `decision-${Date.now()}`,
  type: 'engine_collision' as const,
  title: 'Synthetic gate',
  description: 'Synthetic evidence suggests one path; request operator choice.',
  createdAt: new Date().toISOString(),
  actions: [
    {
      id: 'prepare',
      label: 'Prepare resource',
      description: 'Acquire the required resource before continuing',
      style: 'primary' as const,
    },
    {
      id: 'continue',
      label: 'Continue without resource',
      description: 'Continue without the optional resource',
      style: 'secondary' as const,
    },
    { id: 'abort', label: 'Abort', style: 'danger' as const },
  ],
});

test('decision advice requires opt-in and an exact admitted snapshot, never resolves actions', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'decision-advice-'));
  const oldHome = process.env.FARMSLOT_HOME;
  const oldEnabled = process.env.FARMSLOT_DECISION_ADVICE_ENABLED;
  process.env.FARMSLOT_HOME = home;
  delete process.env.FARMSLOT_DECISION_ADVICE_ENABLED;
  const run = createRun({ flowType: 'fix-bug', project: 'example-farm', ticketOrPr: 'SYNTH-TEST' });
  const decision = makeDecision();
  updateRun(run.id, { status: 'blocked', decisions: [decision] });
  t.after(async () => {
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
    rmSync(home, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = oldHome;
    if (oldEnabled === undefined) delete process.env.FARMSLOT_DECISION_ADVICE_ENABLED;
    else process.env.FARMSLOT_DECISION_ADVICE_ENABLED = oldEnabled;
  });
  const params = { runId: run.id, decisionId: decision.id };
  assert.equal((await withPrincipal(() => decisionAdviceGet(params))).reason, 'disabled');
  process.env.FARMSLOT_DECISION_ADVICE_ENABLED = 'true';
  const pending = await withPrincipal(() => decisionAdviceGet(params));
  assert.equal(pending.reason, 'not-admitted');
  assert.match(pending.snapshotHash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(
    (await withPrincipal(() => decisionAdviceGet({ ...params, runId: 'wrong' }))).reason,
    'not-pending',
  );
  const policy = {
    version: 1,
    entries: [
      {
        ...params,
        snapshotHash: pending.snapshotHash,
        classification: 'synthetic',
        sourceRef: 'synthetic:pilot-case-1',
      },
    ],
    price: {
      version: 1,
      provider: 'typesafe',
      model: 'jev-1.13.0',
      verifiedAt: new Date().toISOString(),
      source: 'https://docs.typesafe.ai/models',
      inputUsdPerMillion: 0.042,
      outputUsdPerMillion: 0,
      maxInputTokens: 65536,
      maxOutputTokens: 512,
    },
    limits: { maxCalls: 2, maxUsd: 0.01 },
  };
  writeFileSync(path.join(home, 'decision-advice-policy.json'), JSON.stringify(policy));
  assert.equal((await withPrincipal(() => decisionAdviceGet(params))).eligible, true);
  assert.equal(
    (
      await withPrincipal(() =>
        decisionAdviceAnalyze({ ...params, expectedSnapshotHash: 'a'.repeat(64) }),
      )
    ).reason,
    'stale',
  );
  decision.description = 'Changed text';
  updateRun(run.id, { decisions: [decision] });
  assert.equal(
    (
      await withPrincipal(() =>
        decisionAdviceAnalyze({ ...params, expectedSnapshotHash: pending.snapshotHash! }),
      )
    ).reason,
    'stale',
  );
  assert.equal((await withPrincipal(() => decisionAdviceGet(params))).reason, 'not-admitted');
  assert.equal(run.decisions[0]?.resolvedAt, undefined);
  decision.type = 'engine_review_posting' as typeof decision.type;
  updateRun(run.id, { decisions: [decision] });
  assert.equal(
    (await withPrincipal(() => decisionAdviceGet(params))).reason,
    'insufficient-options',
  );
});

test('saved invalid action choice stays unavailable on a fresh status read', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'decision-advice-'));
  const oldHome = process.env.FARMSLOT_HOME;
  const oldEnabled = process.env.FARMSLOT_DECISION_ADVICE_ENABLED;
  process.env.FARMSLOT_HOME = home;
  process.env.FARMSLOT_DECISION_ADVICE_ENABLED = 'true';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-farm',
    ticketOrPr: 'SYNTH-INVALID',
  });
  const decision = makeDecision();
  updateRun(run.id, { status: 'blocked', decisions: [decision] });
  t.after(async () => {
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
    rmSync(home, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = oldHome;
    if (oldEnabled === undefined) delete process.env.FARMSLOT_DECISION_ADVICE_ENABLED;
    else process.env.FARMSLOT_DECISION_ADVICE_ENABLED = oldEnabled;
  });
  const params = { runId: run.id, decisionId: decision.id };
  const first = await withPrincipal(() => decisionAdviceGet(params));
  writeFileSync(
    path.join(home, 'decision-advice-policy.json'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          ...params,
          snapshotHash: first.snapshotHash,
          classification: 'synthetic',
          sourceRef: 'synthetic:pilot-case-2',
        },
      ],
      limits: { maxCalls: 1, maxUsd: 0.01 },
      price: {
        version: 1,
        provider: 'synthetic-provider',
        model: 'fixed',
        verifiedAt: new Date().toISOString(),
        source: 'https://example.test/model',
        inputUsdPerMillion: 0.1,
        outputUsdPerMillion: 0.1,
        maxInputTokens: 1000,
        maxOutputTokens: 1000,
      },
    }),
  );
  const record = await beginAssessment({
    ownerId: principal.id,
    consumer: 'decision-advice',
    subject: {
      run: {
        id: run.id,
        project: run.project,
        step: 'decision-advice',
        snapshotHash: first.snapshotHash!,
      },
    },
  });
  await finishAssessment(record, {
    status: 'completed',
    attempted: true,
    answers: { action: { type: 'choice', choice: 'fabricated', probabilities: { fabricated: 1 } } },
  });
  const after = await withPrincipal(() => decisionAdviceGet(params));
  assert.equal(after.reason, 'assessment-unavailable');
  assert.equal(after.recommendedActionId, undefined);
});

test('paid output with missing token usage remains an unknown charge', () => {
  const price = { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.2 };
  assert.equal(estimateDecisionAdviceCost({ inputTokens: 50 }, price), undefined);
  assert.equal(estimateDecisionAdviceCost({ inputTokens: 50, outputTokens: 20 }, price), 0.000044);
  assert.equal(
    estimateDecisionAdviceCost({ inputTokens: 50 }, { ...price, outputUsdPerMillion: 0 }),
    0.00002,
  );
});

test('unverified identity, missing input usage and overspend never produce decision advice', () => {
  const price = {
    inputUsdPerMillion: 0.042,
    outputUsdPerMillion: 0,
    maxInputTokens: 100,
    maxOutputTokens: 50,
  };
  const base: AssessmentResult = {
    status: 'completed',
    attempted: true,
    returnedModel: 'jev-1.13.0',
    answers: {
      action: { type: 'choice' as const, choice: 'continue', probabilities: { continue: 1 } },
    },
    usage: {
      provider: 'typesafe',
      requestedModel: 'jev-1.13.0',
      durationMs: 10,
      inputTokens: 80,
      outputTokens: 20,
    },
  };
  const checked = (result: AssessmentResult) =>
    validateDecisionAdviceResponse(result, 'jev-1.13.0', price, ['continue']);
  assert.equal(checked(base).status, 'completed');
  assert.equal(checked({ ...base, returnedModel: 'other-model' }).status, 'unavailable');
  assert.equal(checked({ ...base, returnedModel: undefined }).status, 'unavailable');
  assert.equal(
    checked({ ...base, usage: { ...base.usage!, inputTokens: undefined } }).status,
    'unavailable',
  );
  assert.equal(
    checked({ ...base, usage: { ...base.usage!, inputTokens: 101 } }).status,
    'unavailable',
  );
  assert.equal(
    checked({ ...base, usage: { ...base.usage!, outputTokens: 51 } }).status,
    'unavailable',
  );
});
