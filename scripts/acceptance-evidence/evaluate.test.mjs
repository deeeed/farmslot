import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { evaluate } from './evaluate.mjs';

const here = new URL('.', import.meta.url);
const [cases, labels] = await Promise.all([
  readFile(new URL('./cases.v2.json', here), 'utf8').then(JSON.parse),
  readFile(new URL('./labels.v2.json', here), 'utf8').then(JSON.parse),
]);

function record(id, runId, entry, { failed = false, unknown = false, verdict = 'supported' } = {}) {
  return {
    version: 1,
    id,
    consumer: 'acceptance-evidence',
    subject: {
      run: {
        id: runId,
        admission: { classification: 'synthetic', sourceRef: 'synthetic:acceptance-evidence-v2' },
        criterion: { id: entry.criterionId, text: entry.criterion, evidence: entry.evidence },
      },
    },
    status: failed ? 'unavailable' : 'completed',
    result: {
      status: failed ? 'unavailable' : 'completed',
      attempted: true,
      ...(failed ? {} : { answers: { verdict: { type: 'choice', choice: verdict } } }),
      usage: unknown
        ? { durationMs: 8 }
        : { inputTokens: 4, outputTokens: 6, costUsd: 0.001, durationMs: 8 },
    },
  };
}
function study({
  badProvider = false,
  unknown = false,
  omitRecord = false,
  failedAttempt = false,
} = {}) {
  const expected = new Map(labels.labels.map((label) => [label.id, label.expected]));
  const records = [];
  const entries = cases.cases.map((entry, index) => {
    if (entry.proofMode !== 'state')
      return { caseId: entry.id, baseline: null, assisted: null, assessmentRecordIds: [] };
    const id = `record-${entry.id}`;
    const assessmentRecordIds = omitRecord ? [] : [id];
    if (!omitRecord)
      records.push(
        record(id, `run-${entry.id}`, entry, {
          unknown: unknown && index === 0,
          verdict:
            badProvider && entry.id === 'held-insufficient-latency'
              ? 'supported'
              : expected.get(entry.id),
        }),
      );
    if (failedAttempt && entry.id === 'dev-contradicted') {
      records.push(record(`${id}-failed`, `run-${entry.id}`, entry, { failed: true }));
      assessmentRecordIds.push(`${id}-failed`);
    }
    const verdict = expected.get(entry.id);
    return {
      caseId: entry.id,
      assistedRunId: `run-${entry.id}`,
      assessmentRecordIds,
      baseline: {
        judgment: expected.get(entry.id),
        elapsedMs: 100,
        workerTokens: 100,
        workerCostUsd: 0.01,
      },
      assisted: { judgment: verdict, elapsedMs: 90, workerTokens: 80, workerCostUsd: 0.008 },
    };
  });
  return { version: 1, cases: entries, assessmentRecords: records };
}

test('balanced frozen corpus passes only with complete equal-correct measurements', () => {
  const result = evaluate(study(), cases, labels);
  assert.equal(result.gate, 'pass');
  assert.equal(result.quality.heldOutAssisted.correct, 9);
  assert.equal(result.assessment.attemptedCalls, 12);
  assert.equal(result.quality.provider.correct, 12);
  assert.equal(result.paired.efficiency, 'win');
  assert.equal(result.exclusions.associatedRecords, 0);
});

test('visual and mixed cases reject any non-null arm or provider association', () => {
  const input = study();
  input.cases.find((entry) => entry.caseId === 'excluded-visual').baseline = {
    judgment: 'supported',
    elapsedMs: 1,
    workerTokens: 1,
    workerCostUsd: 1,
  };
  assert.throws(() => evaluate(input, cases, labels), /visual\/mixed/);
});

test('missing receipt data makes efficiency inconclusive instead of free', () => {
  const result = evaluate(study({ unknown: true }), cases, labels);
  assert.equal(result.assessment.attemptedCalls, 12);
  assert.equal(result.assessment.unknownUsageOrCostCalls, 1);
  assert.equal(result.paired.efficiency, 'inconclusive');
  assert.equal(result.gate, 'inconclusive');
});

test('failed repeated attempts count but cannot pass the no-retry pilot', () => {
  const result = evaluate(study({ failedAttempt: true }), cases, labels);
  assert.equal(result.assessment.attemptedCalls, 13);
  assert.equal(result.gate, 'hold');
  assert.match(result.reasons.join(' '), /repeated/);
});

test('a deliberate wrong provider answer on insufficient evidence holds the frozen quality gate', () => {
  const result = evaluate(study({ badProvider: true }), cases, labels);
  assert.equal(result.gate, 'hold');
  assert.match(result.reasons.join(' '), /quality/);
});

test('a missing paired workflow metric cannot produce an efficiency win', () => {
  const input = study();
  input.cases.find((entry) => entry.caseId === 'held-supported-retry').assisted.workerTokens = null;
  const result = evaluate(input, cases, labels);
  assert.equal(result.paired.efficiency, 'inconclusive');
  assert.equal(result.gate, 'inconclusive');
});

test('missing assessment receipt association is rejected instead of treated as free', () => {
  assert.throws(
    () => evaluate(study({ omitRecord: true }), cases, labels),
    /requires retained assessment/,
  );
});

test('a completed verdict cannot be counted without an attempted provider call', () => {
  const input = study();
  input.assessmentRecords[0].result.attempted = false;
  assert.throws(() => evaluate(input, cases, labels), /without a provider attempt/);
});

test('study and retained record versions must match the supported schema', () => {
  const input = study();
  input.version = 2;
  assert.throws(() => evaluate(input, cases, labels), /study.version/);
  input.version = 1;
  input.assessmentRecords[0].version = 2;
  assert.throws(() => evaluate(input, cases, labels), /assessmentRecords\[0\].version/);
});

test('held-out confusion counts each frozen case and reports missing provider verdicts', () => {
  const input = study();
  const missed = input.assessmentRecords.find(
    (row) => row.id === 'record-held-insufficient-latency',
  );
  missed.result.status = 'unavailable';
  delete missed.result.answers;
  const result = evaluate(input, cases, labels);
  assert.equal(result.quality.provider.heldOut.complete, false);
  assert.equal(result.quality.provider.heldOut.confusion.insufficient.missing, 1);
  assert.equal(
    Object.values(result.quality.provider.heldOut.confusion)
      .flatMap(Object.values)
      .reduce((a, b) => a + b),
    9,
  );
  assert.equal(result.gate, 'inconclusive');
});

test('a wrong definite insufficient verdict holds even if another provider verdict is missing', () => {
  const input = study({ badProvider: true });
  const missed = input.assessmentRecords.find((row) => row.id === 'record-held-supported-retry');
  missed.result.status = 'unavailable';
  delete missed.result.answers;
  assert.equal(evaluate(input, cases, labels).gate, 'hold');
});

test('an assisted validator regression fails the quality gate', () => {
  const input = study();
  input.cases.find((entry) => entry.caseId === 'held-supported-retry').assisted.judgment =
    'insufficient';
  const result = evaluate(input, cases, labels);
  assert.equal(result.gate, 'hold');
  assert.match(result.reasons.join(' '), /quality fell/);
});

test('development cases cannot manufacture held-out workflow savings', () => {
  const input = study();
  for (const row of input.cases.filter((entry) => entry.caseId.startsWith('dev-'))) {
    row.baseline.elapsedMs = 100_000;
    row.baseline.workerTokens = 100_000;
    row.baseline.workerCostUsd = 100;
  }
  for (const row of input.cases.filter((entry) => entry.caseId.startsWith('held-'))) {
    row.assisted.elapsedMs = 110;
    row.assisted.workerTokens = 110;
    row.assisted.workerCostUsd = 0.011;
  }
  const result = evaluate(input, cases, labels);
  assert.equal(result.paired.total, 9);
  assert.equal(result.paired.efficiency, 'no-win');
  assert.equal(result.gate, 'inconclusive');
});

test('already impossible held-out provider floor holds despite missing verdicts', () => {
  const input = study();
  for (const id of ['held-supported-retry', 'held-contradicted-persistence']) {
    const missed = input.assessmentRecords.find((row) => row.id === `record-${id}`);
    missed.result.status = 'unavailable';
    delete missed.result.answers;
  }
  for (const id of ['held-supported-persistence', 'held-contradicted-latency']) {
    const wrong = input.assessmentRecords.find((row) => row.id === `record-${id}`);
    wrong.result.answers.verdict.choice = 'insufficient';
  }
  const result = evaluate(input, cases, labels);
  assert.equal(result.quality.provider.heldOut.complete, false);
  assert.equal(result.gate, 'hold');
});

test('non-synthetic admission is rejected even when evidence text matches', () => {
  const input = study();
  input.assessmentRecords[0].subject.run.admission = {
    classification: 'public',
    sourceRef: 'https://example.com',
  };
  assert.throws(() => evaluate(input, cases, labels), /admission must identify a synthetic source/);
});

test('null study and explicit null corpus selection fail with clear errors', () => {
  assert.throws(() => evaluate(null, cases, labels), /study must be an object/);
  assert.throws(
    () => evaluate({ ...study(), corpusVersion: null }, cases, labels),
    /corpusVersion/,
  );
});

test('v3 offline study binds every record to its frozen gateway packet', async () => {
  const [nextCases, nextLabels] = await Promise.all([
    readFile(new URL('./cases.v3.json', here), 'utf8').then(JSON.parse),
    readFile(new URL('./labels.v3.json', here), 'utf8').then(JSON.parse),
  ]);
  const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const expected = new Map(nextLabels.labels.map((label) => [label.id, label.expected]));
  const records = [];
  const entries = nextCases.cases.map((entry) => {
    if (entry.proofMode !== 'state')
      return { caseId: entry.id, baseline: null, assisted: null, assessmentRecordIds: [] };
    const runId = `run-${entry.id}`;
    const packet = {
      version: 1,
      criterion: { id: entry.criterionId, text: entry.criterion },
      evidence: entry.evidence,
    };
    const result = record(`record-${entry.id}`, runId, entry, { verdict: expected.get(entry.id) });
    result.subject.run.snapshotHash = hash({ runId, packet });
    result.subject.run.admission.sourceRef = `synthetic:acceptance-evidence-v3/${entry.id}`;
    result.subject.run.sources = entry.evidence.map(({ id, text }) => ({
      id,
      sourceId: id,
      digest: hash(text),
    }));
    result.requestedIdentity = {
      inputDigest: hash(packet),
      provider: 'fixture',
      model: 'fixture-model',
      questionSchemaHash: 'a'.repeat(64),
    };
    result.policyVersion = 'acceptance-evidence-v1';
    records.push(result);
    const arm = {
      judgment: expected.get(entry.id),
      elapsedMs: 100,
      workerTokens: 100,
      workerCostUsd: 0.01,
    };
    return {
      caseId: entry.id,
      assistedRunId: runId,
      assessmentRecordIds: [result.id],
      baseline: arm,
      assisted: arm,
    };
  });
  const nextStudy = { version: 1, corpusVersion: 3, cases: entries, assessmentRecords: records };
  assert.equal(evaluate(nextStudy, nextCases, nextLabels).gate, 'inconclusive');
  const altered = structuredClone(nextStudy);
  altered.assessmentRecords[0].requestedIdentity.inputDigest = 'f'.repeat(64);
  assert.throws(() => evaluate(altered, nextCases, nextLabels), /snapshot, input or admission/);
  const changedSchema = structuredClone(nextStudy);
  changedSchema.assessmentRecords[0].requestedIdentity.questionSchemaHash = 'b'.repeat(64);
  assert.throws(() => evaluate(changedSchema, nextCases, nextLabels), /share provider/);
  const changedPolicy = structuredClone(nextStudy);
  changedPolicy.assessmentRecords[0].policyVersion = 'acceptance-evidence-v2';
  assert.throws(() => evaluate(changedPolicy, nextCases, nextLabels), /share provider/);
});
