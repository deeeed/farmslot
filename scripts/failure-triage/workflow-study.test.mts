import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createPlan, scoreStudy, verifyPlan, type PlanOptions } from './workflow-study.mts';

const corpus = JSON.parse(await readFile(new URL('./corpus-v2.json', import.meta.url), 'utf8'));
const labels = new Map<string, string>(
  corpus.cases
    .filter((c: any) => c.split === 'held-out')
    .map((c: any) => [c.id, c.reference.label]),
);
const unclearCaseId = [...labels].find(([, label]) => label === 'unclear')![0];

const options: PlanOptions = {
  provider: 'fixture',
  baseUrl: 'http://127.0.0.1:1',
  priceSource: 'https://example.com/pricing',
  priceApplicability: 'direct',
  priceVerifiedAt: '2026-09-23',
  model: 'fixture-worker',
  reasoning: 'low',
  maxOutputTokens: 256,
  maxInputTokens: 4096,
  maxAttempts: 42,
  maxTotalTokens: 182784,
  maxTotalUsd: 1,
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 1,
  cacheReadMultiplier: 1,
  cacheWriteMultiplier: 1,
};
const native = (
  plan: Awaited<ReturnType<typeof createPlan>>,
  row = plan.rows[0],
  reply?: object,
) => ({
  caseId: row.caseId,
  arm: row.arm,
  promptHash: row.promptHash,
  planHash: plan.planHash,
  workerElapsedMs: 800,
  response: {
    status: 'completed',
    attempted: true,
    requestedModel: plan.options.model,
    returnedModel: plan.options.model,
    responseId: `response_${row.caseId}_${row.arm}`,
    receiptHash: row.promptHash,
    text: JSON.stringify(
      reply ?? {
        label: 'unclear',
        nextCheck: 'inspect the recorded logs',
        evidenceIds: [],
      },
    ),
    inputTokens: 245,
    outputTokens: 36,
    cacheReadTokens: 25,
    cacheWriteTokens: 0,
    inputAccounting: 'includes-cache',
    durationMs: 780,
  },
});

test('a sealed 42-row plan pins reference/source hashes and excludes hidden answers from worker prompts', async () => {
  const plan = await createPlan(options);
  assert.equal(plan.rows.length, 42);
  assert.equal(new Set(plan.rows.map((r) => r.caseId)).size, 21);
  for (const id of new Set(plan.rows.map((r) => r.caseId))) {
    const rows = plan.rows.filter((r) => r.caseId === id);
    assert.deepEqual(rows.map((r) => r.arm).sort(), ['A', 'B']);
    assert.equal(rows[0].packetHash, rows[1].packetHash);
    assert.equal(rows[0].adviceHash, rows[1].adviceHash);
    assert.equal(rows[0].referenceHash, rows[1].referenceHash);
    assert(
      !rows.some((r) =>
        /rationale|reference|controls|receiptHash|usage|confidence|estimatedUsd/.test(r.prompt),
      ),
    );
    assert(!rows.find((r) => r.arm === 'A')!.prompt.includes('cachedAdvice'));
    assert(rows.find((r) => r.arm === 'B')!.prompt.includes('cachedAdvice'));
  }
  assert(await verifyPlan(plan));
  await assert.rejects(
    () => verifyPlan({ ...plan, rows: plan.rows.slice(1) }),
    /Sealed study plan/,
  );
  await assert.rejects(
    () => createPlan({ ...options, maxAttempts: 43 }),
    /Exactly one planned attempt/,
  );
  await assert.rejects(
    () => createPlan({ ...options, maxTotalUsd: 0.01 }),
    /Plan exceeds explicit/,
  );
});

test('all planned rows remain in the denominator with no receipts or unreviewed answers', async () => {
  const plan = await createPlan(options);
  const empty = await scoreStudy(plan, []);
  assert.equal(empty.denominator, 21);
  assert.equal(empty.cases.length, 42);
  assert.equal(empty.pairs.length, 21);
  assert.equal(empty.missing, 42);
  assert.equal(empty.equalQualityPairs, 0);
  assert.equal(empty.savingsClaim, 'unproven');
  assert(empty.pairs.every((p) => p.totalFirstUseElapsedMsDelta === null));
});

test('native receipts count cache once and a missing usage receipt remains unknown', async () => {
  const plan = await createPlan(options);
  const one = native(plan);
  const report = await scoreStudy(plan, [one]);
  const result = report.cases.find((r) => r.caseId === one.caseId && r.arm === one.arm)!;
  assert.equal(result.inputTokens, 245);
  assert.equal(result.outputTokens, 36);
  assert.equal(result.knownEstimatedUsd, (245 + 36) / 1e6);
  const proxyPlan = await createPlan({ ...options, priceApplicability: 'public-reference-only' });
  const proxy = await scoreStudy(proxyPlan, [native(proxyPlan)]);
  assert.equal(proxy.costBasis, 'public-reference-rate-not-load-balancer-billing');
  assert.equal(proxy.cases[0].knownEstimatedUsd, null);
  assert.equal(proxy.unknownCharges, 1);
  assert.equal(proxy.totalFirstUseCostClaim, 'unproven');
  await assert.rejects(
    () => createPlan({ ...options, priceApplicability: undefined as never }),
    /Explicit price applicability required/,
  );
  const premiumPlan = await createPlan({
    ...options,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
    maxTotalUsd: 1,
  });
  const cached = native(premiumPlan, premiumPlan.rows[0]);
  const premiumResult = (
    await scoreStudy(premiumPlan, [
      { ...cached, response: { ...cached.response, cacheWriteTokens: 100 } },
    ])
  ).cases[0];
  assert.equal(premiumPlan.ceilingUsd, (42 * (4096 * 1.25 + 256)) / 1e6);
  assert.equal(premiumResult.knownEstimatedUsd, (120 + 25 * 0.1 + 100 * 1.25 + 36) / 1e6);
  const missingCacheReport = await scoreStudy(premiumPlan, [
    { ...cached, response: { ...cached.response, cacheWriteTokens: null } },
  ]);
  assert.equal(missingCacheReport.cases[0].knownEstimatedUsd, null);
  assert.equal(missingCacheReport.unknownCharges, 1);
  const doubleCounted = (
    await scoreStudy(premiumPlan, [
      { ...cached, response: { ...cached.response, cacheWriteTokens: 240 } },
    ])
  ).cases[0];
  assert.equal(doubleCounted.hasNativeUsage, false);
  assert.equal(doubleCounted.knownEstimatedUsd, null);
  assert.equal(result.quality, null);
  assert.equal(report.attempted, 1);
  assert.equal(report.missing, 41);
  const unknown = await scoreStudy(plan, [
    { ...one, response: { ...one.response, inputTokens: null } },
  ]);
  assert.equal(unknown.unknownCharges, 1);
  assert.equal(
    unknown.cases.find((r) => r.caseId === one.caseId && r.arm === one.arm)!.status,
    'unknown-usage',
  );
  assert(unknown.pairs.every((p) => p.workerTokenDelta === null));
});

test('duplicate native IDs, wrong prompts and mutating checks cannot enter paired comparisons', async () => {
  const plan = await createPlan(options);
  const first = native(plan);
  const second = native(plan, plan.rows[1]);
  await assert.rejects(() => scoreStudy(plan, [first, first]), /duplicate planned attempt/);
  await assert.rejects(
    () =>
      scoreStudy(plan, [
        first,
        { ...second, response: { ...second.response, responseId: first.response.responseId } },
      ]),
    /Duplicate response ID/,
  );
  await assert.rejects(
    () => scoreStudy(plan, [{ ...first, promptHash: 'modified' }]),
    /different worker prompt/,
  );
  const invalid = native(plan, plan.rows[0], {
    label: 'unclear',
    nextCheck: 'delete the broken artifact',
    evidenceIds: [],
  });
  const report = await scoreStudy(plan, [invalid]);
  assert.equal(report.validResponses, 0);
  assert.equal(
    report.cases.find((r) => r.caseId === invalid.caseId && r.arm === invalid.arm)!.status,
    'invalid-answer',
  );
  assert.equal(report.equalQualityPairs, 0);
});

test('blinded adjudication requires evidence; equal-quality comparisons remain worker-only', async () => {
  const plan = await createPlan(options);
  const first = native(plan, plan.rows.find((r) => r.caseId === unclearCaseId)!);
  const second = native(
    plan,
    plan.rows.find((r) => r.caseId === unclearCaseId && r.arm !== first.arm)!,
  );
  const provisional = await scoreStudy(plan, [first, second]);
  assert(
    provisional.graderExport.every(
      (r) =>
        Object.keys(r).sort().join(',') === 'answer,blindId,packet' &&
        !JSON.stringify(r).includes('referenceLabel') &&
        !JSON.stringify(r).includes('diagnosisCorrect'),
    ),
  );
  assert(
    provisional.graderExport.every(
      (r) => r.packet.caseId === r.blindId && r.packet.failure.runId === r.blindId,
    ),
  );
  const reviewerBytes = JSON.stringify(provisional.graderExport);
  assert([...labels.keys()].every((caseId) => !reviewerBytes.includes(caseId)));
  const ids = new Set(
    provisional.cases.filter((r) => r.caseId === first.caseId).map((r) => r.blindId),
  );
  const blind = provisional.graderExport.filter((r) => ids.has(r.blindId));
  await assert.rejects(
    () =>
      scoreStudy(
        plan,
        [first, second],
        [
          {
            blindId: blind[0].blindId,
            result: 'accepted',
            safe: true,
            specific: true,
            supported: true,
            evidence: 'ok',
          },
        ],
      ),
    /Adjudication needs/,
  );
  const decisions = blind.map((r) => ({
    blindId: r.blindId,
    result: 'accepted',
    safe: true,
    specific: true,
    supported: true,
    evidence: 'Specific inspection cites recorded diagnostic evidence.',
  }));
  const reviewed = await scoreStudy(plan, [first, second], decisions);
  assert.equal(reviewed.adjudicated, 2);
  assert.equal(reviewed.equalQualityPairs, 1);
  assert.equal(reviewed.pairs.find((p) => p.caseId === first.caseId)!.workerTokenDelta, 0);
  assert.equal(
    reviewed.pairs.find((p) => p.caseId === first.caseId)!.totalFirstUseElapsedMsDelta,
    reviewed.pairs.find((p) => p.caseId === first.caseId)!.assisted.cachedAdviceDurationMs,
  );
  assert.equal(reviewed.savingsClaim, 'unproven');
});

test('primary cached advice matches pilot display, with separate raw prediction fingerprint', async () => {
  const plan = await createPlan(options);
  const checks: Record<string, string> = {
    environment: 'inspect_prepare',
    dependencies: 'inspect_dependency_resolution',
    implementation: 'inspect_failed_assertion',
    test_harness: 'inspect_test_fixture',
    missing_evidence: 'inspect_evidence',
    external_service: 'inspect_external_response',
    unclear: 'inspect_more_context',
  };
  for (const row of plan.rows.filter((r) => r.arm === 'B')) {
    const displayed = JSON.parse(row.prompt).cachedAdvice;
    assert.equal(displayed.nextCheck, checks[displayed.label]);
    assert.match(row.adviceHash, /^[a-f0-9]{64}$/);
    assert.match(row.rawPredictionHash, /^[a-f0-9]{64}$/);
  }
  assert.equal(plan.advicePolicy, 'pilot-displayed-check-for-label-v1');
  assert.equal(plan.gate.minimumTotalFirstUseTokenReduction, 0.2);
  assert.equal(plan.gate.minimumAssistedDiagnosisAndCheckSuccesses, 16);
  assert.equal(plan.gateHash.length, 64);
});

test('frozen gate charges each assisted first use for cached JEV advice', async () => {
  const plan = await createPlan(options);
  const attempts = plan.rows.map((row) => ({
    ...native(plan, row, {
      label: labels.get(row.caseId),
      nextCheck: 'inspect the recorded diagnostics',
      evidenceIds: ['e1'],
    }),
    response: {
      ...native(plan, row, {
        label: labels.get(row.caseId),
        nextCheck: 'inspect the recorded diagnostics',
        evidenceIds: ['e1'],
      }).response,
      inputTokens: row.arm === 'A' ? 300 : 200,
      outputTokens: 30,
    },
  }));
  const provisional = await scoreStudy(plan, attempts);
  assert.equal(provisional.gateResult.status, 'inconclusive');
  const decisions = provisional.graderExport.map((r) => ({
    blindId: r.blindId,
    result: 'accepted',
    safe: true,
    specific: true,
    supported: true,
    evidence: 'Read-only next check supported by source e1.',
  }));
  const complete = await scoreStudy(plan, attempts, decisions);
  assert.equal(complete.gateResult.status, 'failed');
  assert.equal(complete.gateResult.completeReceipts, 42);
  assert.equal(complete.gateResult.adjudicatedCases, 21);
  assert.equal(complete.gateResult.equalQualityPairs, 21);
  assert.equal(complete.gateResult.aggregateFirstUseTokens.baseline, 21 * 330);
  assert.equal(complete.gateResult.aggregateFirstUseTokens.assistedWorker, 21 * 230);
  assert.equal(complete.gateResult.aggregateFirstUseTokens.assistedCachedAdvice, 26035 + 4305);
  assert.equal(complete.gateResult.aggregateFirstUseTokens.assistedTotal, 21 * 230 + 26035 + 4305);
  assert.equal(complete.savingsClaim, 'unproven');
  assert.equal(complete.totalFirstUseTimeClaim, 'unproven');
  assert.equal(complete.totalFirstUseCostClaim, 'unproven');
  assert.equal(complete.gateResult.assistedDiagnosisAndCheckSuccesses, 21);
  const wrongLabel = (caseId: string) =>
    labels.get(caseId) === 'unclear' ? 'environment' : 'unclear';
  const makeWrong = (attempt: (typeof attempts)[number]) => ({
    ...attempt,
    response: {
      ...attempt.response,
      text: JSON.stringify({
        label: wrongLabel(attempt.caseId),
        nextCheck: 'inspect the recorded diagnostics',
        evidenceIds: ['e1'],
      }),
    },
  });
  const allWrong = await scoreStudy(plan, attempts.map(makeWrong), decisions);
  assert.equal(allWrong.gateResult.baselineSuccessAssistedFailure, 0);
  assert.equal(allWrong.gateResult.assistedDiagnosisAndCheckSuccesses, 0);
  assert.equal(allWrong.gateResult.status, 'failed');
  assert.equal(allWrong.savingsClaim, 'unproven');
  assert.equal(allWrong.totalFirstUseCostClaim, 'unproven');
  const sixCases = new Set([...labels.keys()].slice(0, 6));
  const belowFloor = await scoreStudy(
    plan,
    attempts.map((attempt) => (sixCases.has(attempt.caseId) ? makeWrong(attempt) : attempt)),
    decisions,
  );
  assert.equal(belowFloor.gateResult.assistedDiagnosisAndCheckSuccesses, 15);
  assert.equal(belowFloor.gateResult.baselineSuccessAssistedFailure, 0);
  assert.equal(belowFloor.gateResult.status, 'failed');
  assert.equal(belowFloor.savingsClaim, 'unproven');
  const faster = attempts.map((a) => ({ ...a, workerElapsedMs: a.arm === 'B' ? 400 : 800 }));
  assert.equal((await scoreStudy(plan, faster, decisions)).totalFirstUseTimeClaim, 'unproven');
  const unmeasured = attempts.map((a) => ({
    ...a,
    workerElapsedMs: a.arm === 'B' ? null : a.workerElapsedMs,
  }));
  const unmeasuredResult = await scoreStudy(plan, unmeasured, decisions);
  assert.equal(unmeasuredResult.savingsClaim, 'unproven');
  assert.equal(unmeasuredResult.gateResult.status, 'inconclusive');
  assert.equal(unmeasuredResult.totalFirstUseTimeClaim, 'unproven');
  assert.equal(unmeasuredResult.gateResult.observedFirstUseTimeAndCost.timeReduction, null);
  const largeWorkerSavings = attempts.map((attempt) => ({
    ...attempt,
    response: { ...attempt.response, inputTokens: attempt.arm === 'A' ? 3000 : 100 },
  }));
  const measuredSavings = await scoreStudy(plan, largeWorkerSavings, decisions);
  assert.equal(measuredSavings.gateResult.status, 'inconclusive');
  assert.equal(measuredSavings.executionProvenance, 'offline-fixture');
  assert.equal(
    (await scoreStudy(plan, largeWorkerSavings, decisions, true)).gateResult.status,
    'passed',
  );
  const twoMutualFailures = new Set([...labels.keys()].slice(0, 2));
  const imperfect = largeWorkerSavings.map((attempt) =>
    twoMutualFailures.has(attempt.caseId) ? makeWrong(attempt) : attempt,
  );
  const imperfectReport = await scoreStudy(plan, imperfect, decisions, true);
  assert.equal(imperfectReport.gateResult.equalQualityPairs, 19);
  assert.equal(imperfectReport.gateResult.aggregateFirstUseTokens.baseline, 19 * 3000 + 19 * 30);
  assert.equal(imperfectReport.gateResult.fullCohortFirstUse.baselineTokens, 21 * 3030);
  assert.equal(imperfectReport.gateResult.assistedDiagnosisAndCheckSuccesses, 19);
  assert.equal(imperfectReport.gateResult.status, 'passed');

  const missingTime = largeWorkerSavings.map((attempt, index) =>
    index === 0 ? { ...attempt, workerElapsedMs: null } : attempt,
  );
  const timeUnknown = await scoreStudy(plan, missingTime, decisions);
  assert(timeUnknown.gateResult.aggregateFirstUseTokens.reduction > 0.2);
  assert.equal(timeUnknown.gateResult.status, 'inconclusive');
  assert.equal(timeUnknown.savingsClaim, 'unproven');
  const unknownCost = largeWorkerSavings.map((attempt, index) =>
    index === 0
      ? { ...attempt, response: { ...attempt.response, cacheWriteTokens: null } }
      : attempt,
  );
  const costUnknown = await scoreStudy(plan, unknownCost, decisions);
  assert(costUnknown.gateResult.aggregateFirstUseTokens.reduction > 0.2);
  assert.equal(costUnknown.gateResult.status, 'inconclusive');
  assert.equal(costUnknown.savingsClaim, 'unproven');
  const deficient = await scoreStudy(plan, attempts.slice(1), decisions);
  assert.equal(deficient.gateResult.status, 'inconclusive');
  assert.equal(deficient.savingsClaim, 'unproven');
  const regression = attempts.map((attempt) => ({ ...attempt, response: { ...attempt.response } }));
  const b = regression.find((r) => r.arm === 'B' && labels.get(r.caseId) !== 'unclear')!;
  b.response.text = JSON.stringify({
    label: 'unclear',
    nextCheck: 'inspect the recorded diagnostics',
    evidenceIds: ['e1'],
  });
  const regressed = await scoreStudy(plan, regression, decisions);
  assert.equal(regressed.gateResult.status, 'failed');
  assert.equal(regressed.gateResult.baselineSuccessAssistedFailure, 1);
  assert.equal(regressed.savingsClaim, 'unproven');
  const slow = attempts.map((attempt) => ({
    ...attempt,
    response: { ...attempt.response, inputTokens: 300 },
  }));
  const noSavings = await scoreStudy(plan, slow, decisions);
  assert.equal(noSavings.gateResult.status, 'failed');
  assert.equal(noSavings.savingsClaim, 'unproven');
  assert.equal(noSavings.totalFirstUseCostClaim, 'unproven');
});

test('missing observed time stays unknown without erasing comparable tokens and cost', async () => {
  const plan = await createPlan(options);
  const rows = plan.rows.filter((r) => r.caseId === unclearCaseId);
  const attempts = rows.map((r) => native(plan, r));
  attempts[0].workerElapsedMs = null as unknown as number;
  const provisional = await scoreStudy(plan, attempts);
  const ids = new Set(
    provisional.cases.filter((r) => r.caseId === unclearCaseId).map((r) => r.blindId),
  );
  const blind = provisional.graderExport.filter((r) => ids.has(r.blindId));
  const decisions = blind.map((r) => ({
    blindId: r.blindId,
    result: 'accepted',
    safe: true,
    specific: true,
    supported: true,
    evidence: 'The check reads already-recorded diagnostic evidence.',
  }));
  const report = await scoreStudy(plan, attempts, decisions);
  const pair = report.pairs.find((p) => p.caseId === unclearCaseId)!;
  assert.equal(pair.equalAdjudicatedQuality, true);
  assert.equal(pair.workerElapsedMsDelta, null);
  assert.equal(pair.workerTokenDelta, 0);
  assert.equal(pair.knownWorkerCostDeltaUsd, 0);
  assert.equal(report.gateResult.observedFirstUseTimeAndCost.baselineMs, null);
});
