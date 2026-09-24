#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const frozen = {
  'cases.v1.json': 'c880fb613b2e0d4dbd98d9117021be7493ef55e427a6f68c81994732f5a4208b',
  'labels.v1.json': '5ffe2f6754dd6c9981419f82a8839762e925270c12f1e166cc2f094c16eb1f8b',
  'cases.v2.json': '2d922bb707564cda110b69db37752b84216e99f73e120518542a7a661b4e7d18',
  'labels.v2.json': 'f32c5d367ed71ceae38b8aec883f6cb94780206fe8021d38916c6b133d6223c9',
};
const load = (name) => {
  const bytes = readFileSync(new URL(name, import.meta.url));
  const actual = createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    actual,
    frozen[name],
    `${name} changed; version the corpus before another candidate call`,
  );
  return JSON.parse(bytes);
};
load('cases.v1.json');
load('labels.v1.json');
const { version, cases } = load('cases.v2.json');
const { version: labelVersion, labels } = load('labels.v2.json');
assert.equal(version, 2);
assert.equal(labelVersion, 2);
assert.equal(cases.length, 14);
assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
assert.equal(new Set(labels.map((entry) => entry.id)).size, labels.length);
assert.equal(labels.length, 12);
const labeled = new Map(labels.map((entry) => [entry.id, entry]));
for (const entry of cases) {
  assert.match(entry.criterionId, /^AC-[1-9]\d*$/);
  assert.ok(entry.criterion.trim());
  assert.ok(entry.evidence.length > 0);
  assert.equal(new Set(entry.evidence.map((item) => item.id)).size, entry.evidence.length);
  for (const item of entry.evidence) assert.ok(item.id && item.text.trim());
  if (entry.split === 'excluded') {
    assert.ok(['visual', 'mixed'].includes(entry.proofMode));
    assert.equal(labeled.has(entry.id), false);
  } else {
    assert.equal(entry.proofMode, 'state');
    assert.ok(['development', 'held-out'].includes(entry.split));
    assert.ok(
      ['supported', 'contradicted', 'insufficient'].includes(labeled.get(entry.id)?.expected),
    );
  }
}
for (const label of labels) assert.ok(cases.some((entry) => entry.id === label.id));
for (const split of ['development', 'held-out']) {
  for (const answer of ['supported', 'contradicted', 'insufficient']) {
    const count = cases.filter(
      (entry) => entry.split === split && labeled.get(entry.id)?.expected === answer,
    ).length;
    assert.equal(count, split === 'development' ? 1 : 3, `${split}/${answer} count`);
  }
}
assert.ok(
  cases.every((entry) => entry.criterionId === 'AC-1'),
  'criterion ids must not leak labels',
);
console.log('Frozen AC corpus v2: 3 development, 9 held-out, 2 excluded; 12 labels matched');

// Recompute the recorded adapter probe from frozen labels. This validates the
// stored artifact, not whether its adapter-only history is exhaustive.
const probe = JSON.parse(
  readFileSync(new URL('results/v2-typesafe-adapter.json', import.meta.url)),
);
assert.equal(probe.corpusSha256, frozen['cases.v2.json']);
assert.equal(probe.labelSha256, frozen['labels.v2.json']);
assert.equal(probe.provider, 'typesafe');
assert.equal(probe.requestedModel, 'jev-1.13.0');
assert.equal(probe.calls, 12);
assert.equal(probe.records.length, probe.calls);
const textual = cases.filter((entry) => entry.proofMode === 'state');
assert.deepEqual(
  new Set(probe.records.map((row) => row.caseId)),
  new Set(textual.map((row) => row.id)),
);
let tokens = 0;
let outputTokens = 0;
let heldCorrect = 0;
const wrongInsufficient = [];
for (const row of probe.records) {
  const item = textual.find((entry) => entry.id === row.caseId);
  assert.equal(row.split, item.split);
  assert.equal(row.status, 'completed');
  assert.equal(row.returnedModel, probe.requestedModel);
  assert.ok(['supported', 'contradicted', 'insufficient'].includes(row.verdict));
  assert.ok(Number.isSafeInteger(row.inputTokens) && row.inputTokens >= 0);
  assert.ok(Number.isSafeInteger(row.outputTokens) && row.outputTokens >= 0);
  assert.ok(Number.isFinite(row.durationMs) && row.durationMs >= 0);
  tokens += row.inputTokens;
  outputTokens += row.outputTokens;
  if (item.split !== 'held-out') continue;
  if (row.verdict === labeled.get(row.caseId).expected) heldCorrect++;
  if (labeled.get(row.caseId).expected === 'insufficient' && row.verdict !== 'insufficient')
    wrongInsufficient.push(row.caseId);
}
assert.equal(tokens, 5691);
assert.equal(outputTokens, 561);
assert.equal(heldCorrect, 8);
assert.deepEqual(wrongInsufficient, ['held-insufficient-negative']);
assert.equal(probe.pricing.inputUsdPerMillion, 0.042);
assert.equal(probe.pricing.outputUsdPerMillion, 0);
const estimatedUsd = (tokens * probe.pricing.inputUsdPerMillion) / 1_000_000;
assert.equal(Number(estimatedUsd.toFixed(8)), probe.estimatedUsd);
assert.ok(estimatedUsd <= probe.maxUsd);
console.log(
  `Recorded AC adapter probe: ${heldCorrect}/9 held-out; hold on ${wrongInsufficient.join(', ')}`,
);

// v3 uses gateway-readable artifact paths and opaque IDs; v2 remains an
// unchanged adapter-only result and is never treated as a gateway study.
const v3Hashes = {
  'cases.v3.json': 'ba30af5bea1f9c54e2723220c658dfe0c70fe9f663d37f65380d09a5b679afe4',
  'labels.v3.json': '31ba1b52dad4186d59c6d82ce7923fb400b9bfe6c5aaac5ea7a06bd4fd59f7b1',
};
for (const [name, hash] of Object.entries(v3Hashes)) {
  const bytes = readFileSync(new URL(name, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, `${name} changed`);
}
const nextCases = JSON.parse(readFileSync(new URL('cases.v3.json', import.meta.url)));
const nextLabels = JSON.parse(readFileSync(new URL('labels.v3.json', import.meta.url)));
assert.equal(nextCases.version, 3);
assert.equal(nextLabels.version, 3);
assert.equal(nextCases.cases.length, 14);
assert.equal(nextLabels.labels.length, 12);
assert.equal(new Set(nextCases.cases.map((row) => row.id)).size, 14);
assert.equal(new Set(nextLabels.labels.map((row) => row.id)).size, 12);
const reference = new Map(nextLabels.labels.map((row) => [row.id, row.expected]));
for (const row of nextCases.cases) {
  assert.match(row.id, /^case-[a-f\d]{10}$/);
  assert.equal(row.criterionId, 'AC-1');
  assert.ok(row.criterion && row.evidence.length >= 1 && row.evidence.length <= 4);
  if (row.split === 'excluded') {
    assert.ok(['visual', 'mixed'].includes(row.proofMode));
    assert.equal(reference.has(row.id), false);
  } else {
    assert.equal(row.proofMode, 'state');
    assert.ok(['development', 'held-out'].includes(row.split));
    assert.ok(['supported', 'contradicted', 'insufficient'].includes(reference.get(row.id)));
    for (const item of row.evidence) {
      assert.match(item.id, /^artifacts\/(?:[\w.-]+\/)*[\w.-]+\.(?:md|txt|json|log)$/);
      assert.doesNotMatch(item.id, /(?:image|screenshot|visual)/i);
      assert.ok(item.text && Buffer.byteLength(item.text, 'utf8') <= 4096);
    }
  }
}
for (const label of nextLabels.labels)
  assert.ok(nextCases.cases.some((row) => row.id === label.id));
for (const split of ['development', 'held-out']) {
  for (const verdict of ['supported', 'contradicted', 'insufficient']) {
    assert.equal(
      nextCases.cases.filter((row) => row.split === split && reference.get(row.id) === verdict)
        .length,
      split === 'development' ? 1 : 3,
    );
  }
}
const blindAudit = JSON.parse(
  readFileSync(new URL('results/v3-blind-label-audit.json', import.meta.url)),
);
assert.equal(blindAudit.casesSha256, v3Hashes['cases.v3.json']);
assert.equal(blindAudit.labelsSha256, v3Hashes['labels.v3.json']);
const blindPrompt = Buffer.concat([
  Buffer.from(blindAudit.promptPrefix),
  readFileSync(new URL('cases.v3.json', import.meta.url)),
]);
assert.equal(createHash('sha256').update(blindPrompt).digest('hex'), blindAudit.promptSha256);
const blindRaw = readFileSync(new URL('results/v3-blind-label-raw.json', import.meta.url));
assert.equal(createHash('sha256').update(blindRaw).digest('hex'), blindAudit.rawOutputSha256);
assert.deepEqual(blindAudit.judgments, JSON.parse(blindRaw).judgments);
assert.equal(blindAudit.judgments.length, nextCases.cases.length);
const blindJudgments = new Map(blindAudit.judgments.map((row) => [row.caseId, row.judgment]));
assert.equal(blindJudgments.size, nextCases.cases.length, 'blind audit has duplicate case IDs');
assert.deepEqual(new Set(blindJudgments.keys()), new Set(nextCases.cases.map((row) => row.id)));
let agreement = 0;
for (const row of nextCases.cases) {
  const judgment = blindJudgments.get(row.id);
  if (row.split === 'excluded') assert.equal(judgment, 'no-call');
  else {
    assert.ok(['supported', 'contradicted', 'insufficient'].includes(judgment));
    if (judgment === reference.get(row.id)) agreement++;
  }
}
assert.ok(agreement >= 11, `recorded read agreement ${agreement}/12 is below 11/12`);
console.log(`Frozen gateway AC corpus v3: ${agreement}/12 recorded read agreement; 2 exclusions`);

// Recompute the live v3 operator export. These fields are internally consistent;
// a saved JSON file cannot independently attest the source of provider traffic.
const v3Read = JSON.parse(
  readFileSync(new URL('results/v3-independent-label-read.json', import.meta.url)),
);
const v3Probe = JSON.parse(
  readFileSync(new URL('results/v3-typesafe-gateway-receipts.json', import.meta.url)),
);
assert.equal(v3Read.casesSha256, v3Hashes['cases.v3.json']);
assert.equal(v3Read.labelsSha256, v3Hashes['labels.v3.json']);
assert.equal(v3Probe.casesSha256, v3Hashes['cases.v3.json']);
assert.equal(v3Probe.corpusVersion, 3);
assert.equal(v3Probe.model, 'jev-1.13.0');
assert.equal(v3Probe.assessmentRecords.length, 12);
assert.equal(v3Probe.outcomes.length, 14);
assert.equal(v3Read.rows.length, 14);
const byId = (rows, key) => new Map(rows.map((row) => [row[key], row]));
const readById = byId(v3Read.rows, 'caseId');
const outcomeById = byId(v3Probe.outcomes, 'caseId');
assert.equal(readById.size, 14);
assert.equal(outcomeById.size, 14);
assert.equal(new Set(v3Probe.assessmentRecords.map((row) => row.id)).size, 12);
const hashJSON = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let heldOutCorrect = 0;
let overallCorrect = 0;
let inputTokens = 0;
let v3OutputTokens = 0;
let durationMs = 0;
let costUsd = 0;
for (const entry of nextCases.cases) {
  const expected = reference.get(entry.id) ?? 'no-call';
  assert.equal(readById.get(entry.id).independentJudgment, expected);
  const actual = outcomeById.get(entry.id);
  assert.ok(actual, entry.id);
  const record = v3Probe.assessmentRecords.filter(
    (row) => row.subject.run.admission.sourceRef === `synthetic:acceptance-evidence-v3/${entry.id}`,
  );
  if (entry.proofMode !== 'state') {
    assert.equal(actual.reason, 'non-textual');
    assert.equal(actual.verdict, undefined);
    assert.equal(record.length, 0);
    continue;
  }
  assert.equal(record.length, 1, entry.id);
  const row = record[0];
  const packet = {
    version: 1,
    criterion: { id: entry.criterionId, text: entry.criterion },
    evidence: entry.evidence,
  };
  assert.equal(row.ownerId, 'ac-v3-live-probe');
  assert.ok(row.startedAt.startsWith('2026-09-24T'));
  assert.ok(row.completedAt.startsWith('2026-09-24T'));
  assert.equal(row.consumer, 'acceptance-evidence');
  assert.equal(row.policyVersion, 'acceptance-evidence-v1');
  assert.equal(row.status, 'completed');
  assert.equal(row.result.status, 'completed');
  assert.equal(row.result.attempted, true);
  assert.equal(row.requestedIdentity.provider, 'typesafe');
  assert.equal(row.requestedIdentity.model, v3Probe.model);
  assert.equal(row.result.returnedModel, v3Probe.model);
  assert.equal(
    row.requestedIdentity.questionSchemaHash,
    '37c010cfcc3bb378e16d48f32f6588bedbed5f3137252920b445443490e5eb63',
  );
  assert.equal(row.subject.run.admission.classification, 'synthetic');
  assert.deepEqual(row.subject.run.criterion, { ...packet.criterion, evidence: entry.evidence });
  assert.equal(row.subject.run.snapshotHash, hashJSON({ runId: row.subject.run.id, packet }));
  assert.equal(row.requestedIdentity.inputDigest, hashJSON(packet));
  assert.deepEqual(
    row.subject.run.sources,
    entry.evidence.map(({ id, text }) => ({
      id,
      sourceId: id,
      digest: hashJSON(text),
    })),
  );
  assert.equal(actual.verdict, row.result.answers.verdict.choice);
  assert.equal(row.reservation.price.inputUsdPerMillion, 0.042);
  assert.equal(row.reservation.price.outputUsdPerMillion, 0);
  assert.equal(row.reservation.price.maxInputTokens, 8192);
  assert.equal(row.reservation.maxUsd, (8192 * 0.042) / 1_000_000);
  assert.equal(row.result.usage.costKind, 'estimated');
  assert.equal(row.result.usage.costUsd, (row.result.usage.inputTokens * 0.042) / 1_000_000);
  assert.ok(row.result.usage.requestId);
  inputTokens += row.result.usage.inputTokens;
  v3OutputTokens += row.result.usage.outputTokens;
  durationMs += row.result.usage.durationMs;
  costUsd += row.result.usage.costUsd;
  if (actual.verdict === expected) {
    overallCorrect++;
    if (entry.split === 'held-out') heldOutCorrect++;
  }
  if (entry.id === 'case-57584c0514') {
    assert.equal(actual.verdict, 'supported');
    assert.equal(expected, 'insufficient');
    assert.equal(row.result.answers.verdict.confidence, 0.83);
  }
}
assert.equal(heldOutCorrect, 9);
assert.equal(overallCorrect, 11);
assert.equal(inputTokens, 6132);
assert.equal(v3OutputTokens, 561);
assert.equal(durationMs, 7096);
assert.ok(Math.abs(costUsd - 0.000257544) < 1e-12);
assert.equal(v3Probe.costCeilingUsd, (12 * 8192 * 0.042) / 1_000_000);
console.log('Recorded Jev gateway AC v3: 9/9 held-out, 11/12 overall; 12 receipts and 2 no-calls');
