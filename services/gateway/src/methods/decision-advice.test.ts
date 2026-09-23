import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AssessmentResult } from '@farmslot/protocol';

import { readAssessmentArtifact } from '../assessment/artifacts.js';
import {
  ASSESSMENT_RESPONSE_VALIDATION_ERROR,
  AssessmentResponseError,
  createAssessmentProviderRegistry,
  TRIAGE_SPEND_BOUND_EXCEEDED,
  TRIAGE_SPEND_BOUND_UNVERIFIABLE,
} from '../assessment/provider.js';
import { assessmentRecords, beginAssessment, finishAssessment } from '../assessment/store.js';
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
  decision.description = 'x'.repeat(1201);
  updateRun(run.id, { decisions: [decision] });
  assert.equal(
    (await withPrincipal(() => decisionAdviceGet(params))).reason,
    'insufficient-options',
  );
  assert.equal(run.decisions[0]?.resolvedAt, undefined);
  decision.type = 'engine_review_posting' as typeof decision.type;
  updateRun(run.id, { decisions: [decision] });
  assert.equal(
    (await withPrincipal(() => decisionAdviceGet(params))).reason,
    'insufficient-options',
  );
  decision.type = 'engine_prepare_profile_mismatch' as typeof decision.type;
  decision.description = 'Synthetic profile gate';
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
    provider: 'synthetic-provider',
    returnedModel: 'fixed',
    usage: {
      provider: 'synthetic-provider',
      requestedModel: 'fixed',
      inputTokens: 30,
      outputTokens: 10,
      durationMs: 1,
    },
    answers: { action: { type: 'choice', choice: 'fabricated', probabilities: { fabricated: 1 } } },
  });
  const after = await withPrincipal(() => decisionAdviceGet(params));
  assert.equal(after.reason, 'assessment-unavailable');
  assert.equal(after.assessment?.error, 'Invalid advisory choice');
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
  assert.equal(checked(base).usage?.costKind, 'estimated');
  assert.equal(
    checked({
      ...base,
      status: 'unavailable',
      error: ASSESSMENT_RESPONSE_VALIDATION_ERROR,
      usage: undefined,
    }).error,
    TRIAGE_SPEND_BOUND_UNVERIFIABLE,
  );
  assert.equal(
    checked({
      ...base,
      status: 'unavailable',
      error: ASSESSMENT_RESPONSE_VALIDATION_ERROR,
      usage: { ...base.usage!, inputTokens: 101 },
    }).error,
    TRIAGE_SPEND_BOUND_EXCEEDED,
  );
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
    'completed',
  );
});

test('analyze reserves a single admitted request, saves input and answer, and never resolves the gate', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'decision-advice-analyze-'));
  const previous = Object.fromEntries(
    [
      'FARMSLOT_HOME',
      'FARMSLOT_DECISION_ADVICE_ENABLED',
      'FARMSLOT_ASSESSMENT_ENABLED',
      'FARMSLOT_ASSESSMENT_PROVIDER',
      'FARMSLOT_ASSESSMENT_MODEL',
      'TYPESAFE_API_KEY',
    ].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    FARMSLOT_HOME: home,
    FARMSLOT_DECISION_ADVICE_ENABLED: 'true',
    FARMSLOT_ASSESSMENT_ENABLED: 'true',
    FARMSLOT_ASSESSMENT_PROVIDER: 'typesafe',
    FARMSLOT_ASSESSMENT_MODEL: 'jev-1.13.0',
    TYPESAFE_API_KEY: 'synthetic-test-credential',
  });
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-farm',
    ticketOrPr: 'SYNTH-PAID-PATH',
  });
  const decision = makeDecision();
  updateRun(run.id, { status: 'blocked', decisions: [decision] });
  let secondRun: ReturnType<typeof createRun> | undefined;
  t.after(async () => {
    if (secondRun) {
      updateRun(secondRun.id, { status: 'failed' });
      await deleteRun(secondRun.id);
    }
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const params = { runId: run.id, decisionId: decision.id };
  const initial = await withPrincipal(() => decisionAdviceGet(params));
  const price = {
    version: 1,
    provider: 'typesafe',
    model: 'jev-1.13.0',
    verifiedAt: new Date().toISOString(),
    source: 'https://example.test/model',
    inputUsdPerMillion: 0.042,
    outputUsdPerMillion: 0,
    maxInputTokens: 8192,
    maxOutputTokens: 512,
  };
  writeFileSync(
    path.join(home, 'decision-advice-policy.json'),
    JSON.stringify({
      version: 1,
      price,
      limits: { maxCalls: 1, maxUsd: 0.01 },
      entries: [
        {
          ...params,
          snapshotHash: initial.snapshotHash,
          classification: 'synthetic',
          sourceRef: 'synthetic:paid-path',
        },
      ],
    }),
  );
  let calls = 0;
  const registry = createAssessmentProviderRegistry([
    {
      id: 'typesafe',
      defaultModel: 'jev-1.13.0',
      credentialEnv: 'TYPESAFE_API_KEY',
      capabilities: ['choice'],
      async assess() {
        calls++;
        if (calls === 2 && secondRun) {
          const pending = secondRun.decisions[0]!;
          pending.description = 'A different work item while the provider responds';
          updateRun(secondRun.id, { decisions: [pending] });
        }
        return {
          returnedModel: 'jev-1.13.0',
          answers: {
            action: { type: 'choice' as const, choice: 'continue', probabilities: { continue: 1 } },
          },
          usage: { inputTokens: 80, outputTokens: 10, durationMs: 5 },
        };
      },
    },
  ]);
  const request = { ...params, expectedSnapshotHash: initial.snapshotHash! };
  process.env.FARMSLOT_ASSESSMENT_ENABLED = 'false';
  assert.equal(
    (await withPrincipal(() => decisionAdviceAnalyze(request, registry))).reason,
    'provider-unavailable',
  );
  assert.equal(calls, 0);
  process.env.FARMSLOT_ASSESSMENT_ENABLED = 'true';
  const analyzed = await withPrincipal(() => decisionAdviceAnalyze(request, registry));
  assert.equal(analyzed.recommendedActionId, 'continue', JSON.stringify(analyzed));
  assert.equal(analyzed.assessment?.usage?.costUsd, (80 * price.inputUsdPerMillion) / 1_000_000);
  assert.equal(calls, 1);
  assert.equal(
    (await withPrincipal(() => decisionAdviceAnalyze(request, registry))).recommendedActionId,
    'continue',
  );
  assert.equal(calls, 1);
  assert.equal(
    (await withPrincipal(() => decisionAdviceGet(params))).recommendedActionId,
    'continue',
  );
  assert.equal(run.decisions[0]?.resolvedAt, undefined);
  const saved = (await assessmentRecords(principal.id)).find(
    (record) => record.id === analyzed.assessment?.assessmentId,
  );
  assert.ok(saved);
  assert.equal(saved?.reservation?.price?.provider, 'typesafe');
  assert.equal(
    (
      (await readAssessmentArtifact(
        principal.id,
        'inputs',
        createHash('sha256').update(JSON.stringify(saved.id)).digest('hex'),
      )) as { snapshotHash: string }
    )?.snapshotHash,
    initial.snapshotHash,
  );
  secondRun = createRun({
    flowType: 'fix-bug',
    project: 'example-farm',
    ticketOrPr: 'SYNTH-STALE',
  });
  const secondDecision = makeDecision();
  updateRun(secondRun.id, { status: 'blocked', decisions: [secondDecision] });
  const secondParams = { runId: secondRun.id, decisionId: secondDecision.id };
  const second = await withPrincipal(() => decisionAdviceGet(secondParams));
  const nextPolicy = {
    version: 1,
    price,
    limits: { maxCalls: 1, maxUsd: 0.01 },
    entries: [
      {
        ...params,
        snapshotHash: initial.snapshotHash,
        classification: 'synthetic',
        sourceRef: 'synthetic:paid-path',
      },
      {
        ...secondParams,
        snapshotHash: second.snapshotHash,
        classification: 'synthetic',
        sourceRef: 'synthetic:stale-path',
      },
    ],
  };
  writeFileSync(path.join(home, 'decision-advice-policy.json'), JSON.stringify(nextPolicy));
  const nextRequest = { ...secondParams, expectedSnapshotHash: second.snapshotHash! };
  assert.equal(
    (await withPrincipal(() => decisionAdviceAnalyze(nextRequest, registry))).reason,
    'budget-exhausted',
  );
  assert.equal(calls, 1);
  nextPolicy.limits.maxCalls = 2;
  writeFileSync(path.join(home, 'decision-advice-policy.json'), JSON.stringify(nextPolicy));
  const stale = await withPrincipal(() =>
    decisionAdviceAnalyze(
      {
        ...secondParams,
        expectedSnapshotHash: second.snapshotHash!,
      },
      registry,
    ),
  );
  assert.equal(calls, 2);
  assert.equal(stale.reason, 'stale');
  assert.equal(stale.recommendedActionId, undefined);
  assert.equal(secondRun.decisions[0]?.resolvedAt, undefined);
});

test('failed provider validation locks the same price bound before another paid attempt', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'decision-advice-spend-lock-'));
  const previous = Object.fromEntries(
    [
      'FARMSLOT_HOME',
      'FARMSLOT_DECISION_ADVICE_ENABLED',
      'FARMSLOT_ASSESSMENT_ENABLED',
      'FARMSLOT_ASSESSMENT_PROVIDER',
      'FARMSLOT_ASSESSMENT_MODEL',
      'TYPESAFE_API_KEY',
    ].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    FARMSLOT_HOME: home,
    FARMSLOT_DECISION_ADVICE_ENABLED: 'true',
    FARMSLOT_ASSESSMENT_ENABLED: 'true',
    FARMSLOT_ASSESSMENT_PROVIDER: 'typesafe',
    FARMSLOT_ASSESSMENT_MODEL: 'jev-1.13.0',
    TYPESAFE_API_KEY: 'synthetic-test-credential',
  });
  const runs = [0, 1].map(() =>
    createRun({ flowType: 'fix-bug', project: 'example-farm', ticketOrPr: 'SYNTH-LOCK' }),
  );
  const decisions = runs.map(() => makeDecision());
  runs.forEach((run, i) => updateRun(run.id, { status: 'blocked', decisions: [decisions[i]] }));
  t.after(async () => {
    for (const run of runs) {
      updateRun(run.id, { status: 'failed' });
      await deleteRun(run.id);
    }
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const entries = await Promise.all(
    runs.map(async (run, index) => {
      const decisionId = decisions[index].id;
      const status = await withPrincipal(() => decisionAdviceGet({ runId: run.id, decisionId }));
      return {
        runId: run.id,
        decisionId,
        snapshotHash: status.snapshotHash,
        classification: 'synthetic',
        sourceRef: 'synthetic:price-lock',
      };
    }),
  );
  writeFileSync(
    path.join(home, 'decision-advice-policy.json'),
    JSON.stringify({
      version: 1,
      price: {
        version: 1,
        provider: 'typesafe',
        model: 'jev-1.13.0',
        verifiedAt: new Date().toISOString(),
        source: 'https://example.test/model',
        inputUsdPerMillion: 0.042,
        outputUsdPerMillion: 0,
        maxInputTokens: 8192,
        maxOutputTokens: 512,
      },
      limits: { maxCalls: 2, maxUsd: 0.01 },
      entries,
    }),
  );
  let calls = 0;
  const registry = createAssessmentProviderRegistry([
    {
      id: 'typesafe',
      defaultModel: 'jev-1.13.0',
      credentialEnv: 'TYPESAFE_API_KEY',
      capabilities: ['choice'],
      async assess() {
        calls++;
        throw new AssessmentResponseError(
          ASSESSMENT_RESPONSE_VALIDATION_ERROR,
          true,
          undefined,
          undefined,
          true,
        );
      },
    },
  ]);
  const first = await withPrincipal(() =>
    decisionAdviceAnalyze(
      {
        runId: entries[0].runId,
        decisionId: entries[0].decisionId,
        expectedSnapshotHash: entries[0].snapshotHash!,
      },
      registry,
    ),
  );
  assert.equal(first.assessment?.error, TRIAGE_SPEND_BOUND_UNVERIFIABLE);
  const next = await withPrincipal(() =>
    decisionAdviceAnalyze(
      {
        runId: entries[1].runId,
        decisionId: entries[1].decisionId,
        expectedSnapshotHash: entries[1].snapshotHash!,
      },
      registry,
    ),
  );
  assert.equal(next.reason, 'price-unavailable');
  assert.equal(calls, 1);
});
