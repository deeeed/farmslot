#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const VERDICTS = new Set(['supported', 'contradicted', 'insufficient']);
const V3_QUESTION_SCHEMA_HASH = '37c010cfcc3bb378e16d48f32f6588bedbed5f3137252920b445443490e5eb63';
const EXCLUDED_MODES = new Set(['visual', 'mixed']);
const FROZEN_HASHES = {
  2: {
    cases: '2d922bb707564cda110b69db37752b84216e99f73e120518542a7a661b4e7d18',
    labels: 'f32c5d367ed71ceae38b8aec883f6cb94780206fe8021d38916c6b133d6223c9',
  },
  3: {
    cases: '41261ac446de4887d7665b008eef4828dcddb52bbb3a0d21d4a4f66952488085',
    labels: '4ab04f3a0f4157000f11f425c15092d4603ba9e5f6b7e4255a396efc5a749986',
  },
};

function fail(message) {
  throw new Error(message);
}

function finite(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    fail(`${path} must be a non-negative number`);
  return value;
}

function nullableMetric(value, path) {
  if (value === null) return null;
  return finite(value, path);
}

function metricTotal(rows, key) {
  if (rows.some((row) => row[key] === null)) return null;
  return rows.reduce((total, row) => total + row[key], 0);
}

function metricRow(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${path} must be an object`);
  if (!VERDICTS.has(value.judgment)) fail(`${path}.judgment must be a supported verdict`);
  return {
    judgment: value.judgment,
    elapsedMs: nullableMetric(value.elapsedMs, `${path}.elapsedMs`),
    workerTokens: nullableMetric(value.workerTokens, `${path}.workerTokens`),
    workerCostUsd: nullableMetric(value.workerCostUsd, `${path}.workerCostUsd`),
  };
}

function attempt(record) {
  const result = record.result;
  if (!result || typeof result !== 'object')
    return !['disabled', 'skipped'].includes(record.status);
  if (result.attempted === true) return true;
  if (result.attempted === false) return false;
  // A persisted unavailable/started record without the attempt bit cannot be priced
  // or safely assumed free. Keep it visible as an unknown attempt.
  return !['disabled', 'skipped'].includes(result.status ?? record.status);
}

function normalizeRecord(record, path) {
  if (!record || typeof record !== 'object' || Array.isArray(record))
    fail(`${path} must be an object`);
  if (record.version !== 1) fail(`${path}.version must be 1`);
  if (record.consumer !== 'acceptance-evidence')
    fail(`${path}.consumer must be acceptance-evidence`);
  if (typeof record.id !== 'string' || !record.id) fail(`${path}.id is required`);
  const runId = record.subject?.run?.id;
  if (typeof runId !== 'string' || !runId) fail(`${path}.subject.run.id is required`);
  const criterion = record.subject.run.criterion;
  if (
    !criterion ||
    typeof criterion.id !== 'string' ||
    typeof criterion.text !== 'string' ||
    !Array.isArray(criterion.evidence)
  )
    fail(`${path}.subject.run.criterion with evidence is required`);
  const admission = record.subject.run.admission;
  if (
    admission?.classification !== 'synthetic' ||
    !/^synthetic:[\w./-]+$/.test(admission.sourceRef)
  )
    fail(`${path}.subject.run.admission must identify a synthetic source`);
  const usage = record.result?.usage;
  const used = attempt(record);
  const verdict = record.result?.answers?.verdict;
  if (record.result?.status === 'completed' && !used)
    fail(`${path} cannot have a completed verdict without a provider attempt`);
  if (verdict !== undefined && (verdict?.type !== 'choice' || !VERDICTS.has(verdict.choice)))
    fail(`${path}.result.answers.verdict must be a supported choice`);
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  const tokens =
    used && (input === undefined || output === undefined)
      ? null
      : used
        ? finite(input, `${path}.result.usage.inputTokens`) +
          finite(output, `${path}.result.usage.outputTokens`)
        : 0;
  const cost =
    used && usage?.costUsd === undefined
      ? null
      : used
        ? finite(usage.costUsd, `${path}.result.usage.costUsd`)
        : 0;
  const latency =
    used && usage?.durationMs === undefined
      ? null
      : used
        ? finite(usage.durationMs, `${path}.result.usage.durationMs`)
        : 0;
  return {
    id: record.id,
    runId,
    criterion,
    snapshotHash: record.subject.run.snapshotHash,
    sourceRef: admission.sourceRef,
    inputDigest: record.requestedIdentity?.inputDigest,
    provider: record.requestedIdentity?.provider,
    model: record.requestedIdentity?.model,
    questionSchemaHash: record.requestedIdentity?.questionSchemaHash,
    policyVersion: record.policyVersion,
    sources: record.subject.run.sources,
    attempted: used,
    tokens,
    cost,
    latency,
    status: record.result?.status ?? record.status,
    verdict: record.result?.status === 'completed' ? (verdict?.choice ?? null) : null,
  };
}

function matchesFrozenCriterion(record, frozen) {
  return (
    record.criterion.id === frozen.criterionId &&
    record.criterion.text === frozen.criterion &&
    record.criterion.evidence.length === frozen.evidence.length &&
    record.criterion.evidence.every(
      (evidence, index) =>
        evidence?.id === frozen.evidence[index].id &&
        evidence?.text === frozen.evidence[index].text,
    )
  );
}

function totals(rows, fields) {
  return Object.fromEntries(fields.map((field) => [field, metricTotal(rows, field)]));
}

/**
 * Evaluate one immutable, offline AC study. This deliberately accepts plain JSON
 * rather than importing gateway code, so it can be run from a retained artifact.
 */
export function evaluate(study, frozenCases, labels) {
  if (!study || typeof study !== 'object' || Array.isArray(study)) fail('study must be an object');
  if (study.version !== 1) fail('study.version must be 1');
  const corpusVersion = study.corpusVersion === undefined ? 2 : study.corpusVersion;
  if (
    ![2, 3].includes(corpusVersion) ||
    frozenCases.version !== corpusVersion ||
    labels.version !== corpusVersion
  )
    fail('study.corpusVersion must match a supported frozen corpus');
  if (!Array.isArray(study.cases) || !Array.isArray(study.assessmentRecords))
    fail('study.cases and study.assessmentRecords are required arrays');
  const caseById = new Map(frozenCases.cases.map((entry) => [entry.id, entry]));
  const labelById = new Map(labels.labels.map((entry) => [entry.id, entry.expected]));
  if (study.cases.length !== caseById.size)
    fail('study must contain each frozen case exactly once');

  const records = study.assessmentRecords.map((record, index) =>
    normalizeRecord(record, `assessmentRecords[${index}]`),
  );
  if (corpusVersion === 3) {
    if (
      records.some(
        (record) =>
          record.policyVersion !== 'acceptance-evidence-v1' ||
          !record.provider ||
          !record.model ||
          record.questionSchemaHash !== V3_QUESTION_SCHEMA_HASH,
      ) ||
      new Set(
        records.map((record) =>
          JSON.stringify([record.provider, record.model, record.questionSchemaHash]),
        ),
      ).size !== 1
    )
      fail('v3 assessment records must share provider, model, question schema and policy');
  }
  const recordById = new Map();
  for (const record of records) {
    if (recordById.has(record.id)) fail(`duplicate assessment record ${record.id}`);
    recordById.set(record.id, record);
  }
  const bound = new Set();
  const rows = [];
  const caseForRun = new Map();

  for (const [index, entry] of study.cases.entries()) {
    if (!entry || typeof entry !== 'object') fail(`cases[${index}] must be an object`);
    const frozen = caseById.get(entry.caseId);
    if (!frozen) fail(`cases[${index}].caseId is not frozen`);
    if (rows.some((row) => row.caseId === entry.caseId))
      fail(`duplicate study case ${entry.caseId}`);
    const excluded = EXCLUDED_MODES.has(frozen.proofMode);
    const ids = entry.assessmentRecordIds ?? [];
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string'))
      fail(`cases[${index}].assessmentRecordIds must be string array`);
    const linked = ids.map((id) => {
      const record = recordById.get(id);
      if (!record) fail(`cases[${index}] references missing assessment record ${id}`);
      if (bound.has(id)) fail(`assessment record ${id} is associated more than once`);
      bound.add(id);
      return record;
    });
    if (excluded) {
      if (entry.baseline !== null || entry.assisted !== null || linked.length)
        fail(`${entry.caseId} is visual/mixed and must have null arms and no assessment records`);
      continue;
    }
    if (!linked.length) fail(`${entry.caseId} requires retained assessment record IDs`);
    if (linked.some((record) => record.runId !== entry.assistedRunId))
      fail(`${entry.caseId} record run does not match assistedRunId`);
    if (linked.some((record) => !matchesFrozenCriterion(record, frozen)))
      fail(`${entry.caseId} record criterion/evidence does not match frozen case`);
    if (
      corpusVersion === 3 &&
      linked.some((record) => {
        const packet = {
          version: 1,
          criterion: { id: frozen.criterionId, text: frozen.criterion },
          evidence: frozen.evidence.map(({ id, text }) => ({ id, text })),
        };
        const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
        return (
          record.snapshotHash !== hash({ runId: record.runId, packet }) ||
          record.inputDigest !== hash(packet) ||
          !Array.isArray(record.sources) ||
          record.sources.length !== frozen.evidence.length ||
          record.sources.some((source, index) => {
            const evidence = frozen.evidence[index];
            return (
              source?.id !== evidence.id ||
              source?.sourceId !== evidence.id ||
              source?.digest !== hash(evidence.text)
            );
          }) ||
          record.sourceRef !== `synthetic:acceptance-evidence-v3/${entry.caseId}`
        );
      })
    )
      fail(`${entry.caseId} record snapshot, input or admission does not match the gateway packet`);
    const previousCase = caseForRun.get(entry.assistedRunId);
    if (previousCase && previousCase !== entry.caseId)
      fail(`assisted run ${entry.assistedRunId} is associated with multiple frozen cases`);
    caseForRun.set(entry.assistedRunId, entry.caseId);
    const baseline = metricRow(entry.baseline, `cases[${index}].baseline`);
    const assisted = metricRow(entry.assisted, `cases[${index}].assisted`);
    const expected = labelById.get(entry.caseId);
    if (!expected) fail(`${entry.caseId} is missing frozen label`);
    const assessment = totals(linked, ['tokens', 'cost', 'latency']);
    const assistedTokens =
      assisted.workerTokens === null || assessment.tokens === null
        ? null
        : assisted.workerTokens + assessment.tokens;
    const assistedCost =
      assisted.workerCostUsd === null || assessment.cost === null
        ? null
        : assisted.workerCostUsd + assessment.cost;
    rows.push({
      caseId: entry.caseId,
      split: frozen.split,
      expected,
      baseline: { ...baseline, correct: baseline.judgment === expected },
      assisted: { ...assisted, correct: assisted.judgment === expected },
      assessment: {
        ...assessment,
        attempts: linked.filter((record) => record.attempted).length,
        unknownAttempts: linked.filter(
          (record) => record.attempted && (record.tokens === null || record.cost === null),
        ).length,
      },
      providerJudgments: linked
        .filter((record) => record.verdict !== null)
        .map((record) => ({ verdict: record.verdict, correct: record.verdict === expected })),
      combined: { elapsedMs: assisted.elapsedMs, tokens: assistedTokens, costUsd: assistedCost },
    });
  }
  if (bound.size !== records.length)
    fail('every supplied assessment record must be associated with exactly one study case');
  const textual = rows;
  const heldOut = rows.filter((row) => row.split === 'held-out');
  const quality = (arm, subset = textual) => ({
    correct: subset.filter((row) => row[arm].correct).length,
    total: subset.length,
    accuracy: subset.length
      ? subset.filter((row) => row[arm].correct).length / subset.length
      : null,
  });
  const equalQuality = heldOut.filter((row) => row.baseline.correct && row.assisted.correct);
  const paired = {
    total: heldOut.length,
    equalCorrect: equalQuality.length,
    unequalOrIncorrect: heldOut.length - equalQuality.length,
    baseline: totals(
      equalQuality.map((row) => ({
        tokens: row.baseline.workerTokens,
        costUsd: row.baseline.workerCostUsd,
        elapsedMs: row.baseline.elapsedMs,
      })),
      ['tokens', 'costUsd', 'elapsedMs'],
    ),
    assisted: totals(
      equalQuality.map((row) => ({
        tokens: row.combined.tokens,
        costUsd: row.combined.costUsd,
        elapsedMs: row.combined.elapsedMs,
      })),
      ['tokens', 'costUsd', 'elapsedMs'],
    ),
  };
  const measurementsComplete =
    paired.equalCorrect > 0 &&
    records.every(
      (record) => !record.attempted || (record.tokens !== null && record.cost !== null),
    ) &&
    Object.values(paired.baseline).every((value) => value !== null) &&
    Object.values(paired.assisted).every((value) => value !== null);
  const efficiency =
    measurementsComplete && paired.equalCorrect === paired.total
      ? ['tokens', 'costUsd', 'elapsedMs'].every(
          (key) => paired.assisted[key] < paired.baseline[key],
        )
        ? 'win'
        : 'no-win'
      : 'inconclusive';
  const assistedHeldOut = quality('assisted', heldOut);
  const providerJudgments = rows.flatMap((row) => row.providerJudgments);
  const providerQuality = {
    correct: providerJudgments.filter((row) => row.correct).length,
    total: providerJudgments.length,
    accuracy: providerJudgments.length
      ? providerJudgments.filter((row) => row.correct).length / providerJudgments.length
      : null,
  };
  const providerHeldOutRows = heldOut.filter((row) => row.providerJudgments.length === 1);
  const providerHeldOut = {
    correct: providerHeldOutRows.filter((row) => row.providerJudgments[0].correct).length,
    total: providerHeldOutRows.length,
    expectedCases: heldOut.length,
    accuracy: providerHeldOutRows.length
      ? providerHeldOutRows.filter((row) => row.providerJudgments[0].correct).length /
        providerHeldOutRows.length
      : null,
    complete: providerHeldOutRows.length === heldOut.length,
  };
  providerHeldOut.confusion = Object.fromEntries(
    [...VERDICTS].map((expected) => [
      expected,
      Object.fromEntries([...VERDICTS, 'missing'].map((predicted) => [predicted, 0])),
    ]),
  );
  for (const row of heldOut) {
    const prediction =
      row.providerJudgments.length === 1 ? row.providerJudgments[0].verdict : 'missing';
    providerHeldOut.confusion[row.expected][prediction]++;
  }
  const providerWrongInsufficient = heldOut.some(
    (row) =>
      row.expected === 'insufficient' &&
      row.providerJudgments.some((judgment) => !judgment.correct),
  );
  const qualityHold =
    providerWrongInsufficient ||
    providerHeldOut.expectedCases !== 9 ||
    providerHeldOut.correct + (providerHeldOut.expectedCases - providerHeldOut.total) < 8;
  const qualityRegression = rows.some((row) => row.baseline.correct && !row.assisted.correct);
  const repeatedAttempt = rows.some((row) => row.assessment.attempts > 1);
  const gate =
    qualityHold || qualityRegression || repeatedAttempt
      ? 'hold'
      : !providerHeldOut.complete
        ? 'inconclusive'
        : efficiency === 'win'
          ? 'pass'
          : 'inconclusive';
  return {
    version: 1,
    gate,
    reasons: [
      ...(qualityHold ? ['held-out provider quality does not meet the frozen floor'] : []),
      ...(qualityRegression ? ['assisted validator quality fell below its paired baseline'] : []),
      ...(repeatedAttempt
        ? ['pilot policy violation: a case has repeated attempted provider calls']
        : []),
      ...(!providerHeldOut.complete
        ? ['no pass: every held-out case needs exactly one retained provider verdict']
        : []),
      ...(efficiency === 'inconclusive'
        ? ['no efficiency claim: equal-correct pairs or complete measurements are missing']
        : []),
      ...(efficiency === 'no-win'
        ? ['no efficiency claim: equal-correct totals did not improve on every measure']
        : []),
    ],
    scope: `offline frozen-v${corpusVersion} synthetic study; input assertions are not a demonstrated real-world gain`,
    exclusions: {
      visualMixedCases: frozenCases.cases.filter((entry) => EXCLUDED_MODES.has(entry.proofMode))
        .length,
      associatedRecords: 0,
    },
    quality: {
      baseline: quality('baseline'),
      assisted: quality('assisted'),
      heldOutAssisted: assistedHeldOut,
      provider: { ...providerQuality, heldOut: providerHeldOut },
      rows,
    },
    assessment: {
      records: records.length,
      attemptedCalls: records.filter((record) => record.attempted).length,
      unknownUsageOrCostCalls: records.filter(
        (record) => record.attempted && (record.tokens === null || record.cost === null),
      ).length,
      totals: totals(
        records.filter((record) => record.attempted),
        ['tokens', 'cost', 'latency'],
      ),
    },
    paired: { ...paired, efficiency },
  };
}

async function main() {
  const [studyPath] = process.argv.slice(2);
  if (!studyPath || process.argv.length !== 3)
    fail('Usage: node scripts/acceptance-evidence/evaluate.mjs <study.json>');
  const here = new URL('.', import.meta.url);
  const study = JSON.parse(await readFile(studyPath, 'utf8'));
  const version = study?.corpusVersion === undefined ? 2 : study.corpusVersion;
  if (![2, 3].includes(version)) fail('unsupported frozen corpus version');
  const [caseText, labelText] = await Promise.all([
    readFile(new URL(`./cases.v${version}.json`, here), 'utf8'),
    readFile(new URL(`./labels.v${version}.json`, here), 'utf8'),
  ]);
  if (
    createHash('sha256').update(caseText).digest('hex') !== FROZEN_HASHES[version].cases ||
    createHash('sha256').update(labelText).digest('hex') !== FROZEN_HASHES[version].labels
  )
    fail(`frozen v${version} cases or labels hash does not match README`);
  console.log(
    JSON.stringify(evaluate(study, JSON.parse(caseText), JSON.parse(labelText)), null, 2),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'evaluation failed');
    process.exitCode = 1;
  });
}
