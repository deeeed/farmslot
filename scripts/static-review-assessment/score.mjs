#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { decodeOutcome, packet, verifyCorpus } from './check.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const choices = ['violation', 'satisfied', 'not-applicable', 'insufficient'];
const source = (id) => `synthetic:static-review-v2/${id}`;

export function score(study) {
  const { cases, labels, hashes } = verifyCorpus();
  assert.equal(study?.version, 1);
  assert.ok(['live', 'fixture'].includes(study.mode));
  assert.equal(study.corpusSha256, hashes['cases.v2.json']);
  assert.equal(study.labelsSha256, hashes['labels.v2.json']);
  assert.match(study.provider, /^[\w.-]{1,100}$/);
  assert.match(study.model, /^[\w.-]{1,100}$/);
  assert.equal(study.price?.version, 1);
  assert.equal(study.price.provider, study.provider);
  assert.equal(study.price.model, study.model);
  assert.match(study.price.source, /^https:\/\/[^\s]+$/);
  const perCallReserve =
    (study.price.maxInputTokens * study.price.inputUsdPerMillion +
      study.price.maxOutputTokens * study.price.outputUsdPerMillion) /
    1_000_000;
  assert.ok(Number.isFinite(perCallReserve) && perCallReserve > 0);
  assert.ok(Math.abs(study.maxReservedUsd - perCallReserve * 12) < 1e-12);
  assert.ok(study.maxReservedUsd <= 0.01);
  assert.ok(Array.isArray(study.records) && study.records.length <= 200);
  const entries = new Map(cases.cases.map((row) => [source(row.id), row]));
  const references = new Map(labels.labels.map((row) => [row.id, row]));
  const seen = new Set();
  const confusion = Object.fromEntries(
    choices.map((expected) => [
      expected,
      Object.fromEntries(choices.map((predicted) => [predicted, 0])),
    ]),
  );
  const bySplit = { development: { correct: 0, total: 4 }, 'held-out': { correct: 0, total: 8 } };
  let reservedUsd = 0,
    completed = 0,
    attempted = 0,
    duplicates = 0,
    unknownCharges = 0,
    invalidOutputs = 0,
    missingEndToEnd = 0,
    endToEndMs = 0,
    invalidLocations = 0,
    falseConfidentInsufficient = 0,
    costUsd = 0,
    inputTokens = 0,
    outputTokens = 0,
    providerMs = 0;
  for (const record of study.records) {
    const admission = record?.subject?.run?.admission;
    const caseId = admission?.sourceRef?.replace(/^synthetic:static-review-v2\//, '');
    const entry = entries.get(admission?.sourceRef);
    assert.ok(entry, 'record has unknown synthetic source');
    assert.equal(admission.classification, 'synthetic');
    const duplicate = seen.has(caseId);
    if (duplicate) duplicates++;
    seen.add(caseId);
    assert.equal(record.version, 1);
    assert.equal(record.consumer, 'static-review-checklist');
    assert.equal(record.ownerId, 'static-review-pilot');
    assert.equal(record.policyVersion, 'static-review-checklist-pilot-v3');
    assert.equal(record.subject.run.id, caseId);
    assert.equal(record.subject.run.project, 'synthetic');
    assert.equal(record.subject.run.step, 'static-review-checklist:v2');
    assert.equal(record.subject.run.snapshotHash, digest(packet(entry).state));
    assert.equal(
      record.reservation?.key,
      digest([
        'static-review-checklist-pilot-v3',
        caseId,
        study.provider,
        study.model,
        digest(packet(entry).state),
      ]),
    );
    assert.equal(record.reservation?.priceHash, digest(study.price));
    assert.deepEqual(record.reservation?.price, {
      ...study.price,
      maxRequestTokens: study.price.maxInputTokens + study.price.maxOutputTokens,
    });
    assert.ok(Math.abs(record.reservation.maxUsd - perCallReserve) < 1e-12);
    reservedUsd += record.reservation.maxUsd;
    assert.equal(record.requestedIdentity?.provider, study.provider);
    assert.equal(record.requestedIdentity?.model, study.model);
    assert.equal(record.requestedIdentity?.inputDigest, digest(packet(entry).state));
    assert.equal(record.requestedIdentity?.questionSchemaHash, digest(packet(entry).questions));
    if (record.result) {
      assert.equal(record.result.provider, study.provider);
      assert.equal(record.result.requestedModel, study.model);
    }
    if (record.result?.attempted === true) attempted++;
    const usage = record.result?.usage;
    const countedTokens =
      Number.isSafeInteger(usage?.inputTokens) &&
      usage.inputTokens >= 0 &&
      Number.isSafeInteger(usage?.outputTokens) &&
      usage.outputTokens >= 0;
    const countedCost =
      Number.isFinite(usage?.costUsd) &&
      usage.costUsd >= 0 &&
      ['estimated', 'reported'].includes(usage.costKind);
    const countedTime = Number.isFinite(usage?.durationMs) && usage.durationMs >= 0;
    if (countedTokens) {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
    }
    if (countedCost) costUsd += usage.costUsd;
    const pricedCorrectly =
      study.mode === 'fixture' ||
      (countedCost &&
        (!countedTokens ||
          usage.costKind !== 'estimated' ||
          Math.abs(
            usage.costUsd -
              (usage.inputTokens * study.price.inputUsdPerMillion +
                usage.outputTokens * study.price.outputUsdPerMillion) /
                1_000_000,
          ) < 1e-12));
    if (countedTime) providerMs += usage.durationMs;
    const started = Date.parse(record.startedAt);
    const ended = Date.parse(record.completedAt);
    if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started)
      endToEndMs += ended - started;
    else missingEndToEnd++;
    if (
      record.result?.attempted !== true ||
      !countedTokens ||
      !countedCost ||
      !countedTime ||
      !pricedCorrectly
    )
      unknownCharges++;
    if (record.status !== 'completed' || record.result?.status !== 'completed') continue;
    completed++;
    if (duplicate) continue; // A repeated call counts in cost, never improves this case's score.
    assert.equal(record.result.returnedModel, study.model);
    const answer = record.result.answers?.outcome;
    const decoded = answer?.type === 'choice' ? decodeOutcome(entry, answer.choice) : null;
    if (!decoded) {
      invalidOutputs++;
      continue;
    }
    const { verdict, location } = decoded;
    const reference = references.get(caseId);
    confusion[reference.expected][verdict]++;
    const correctLocation = reference.locations.length
      ? reference.locations.includes(location)
      : location === 'none';
    if (
      !correctLocation ||
      (verdict === 'violation' && location === 'none') ||
      (verdict !== 'violation' && location !== 'none')
    )
      invalidLocations++;
    if (reference.expected === 'insufficient' && ['violation', 'satisfied'].includes(verdict))
      falseConfidentInsufficient++;
    if (verdict === reference.expected && correctLocation) bySplit[entry.split].correct++;
  }
  const complete = seen.size === 12 && duplicates === 0 && attempted === 12 && completed === 12;
  const classificationCandidate =
    study.mode === 'live' &&
    complete &&
    unknownCharges === 0 &&
    reservedUsd <= 0.01 &&
    invalidOutputs === 0 &&
    costUsd <= 0.01 &&
    bySplit['held-out'].correct >= 7 &&
    invalidLocations === 0 &&
    falseConfidentInsufficient === 0;
  return {
    version: 1,
    mode: study.mode,
    provider: study.provider,
    model: study.model,
    attempted,
    completed,
    duplicates,
    missingCases: 12 - seen.size,
    unknownCharges,
    reservedUsd,
    priceSource: study.price.source,
    priceVerifiedAt: study.price.verifiedAt,
    invalidOutputs,
    missingEndToEnd,
    endToEndMs,
    costUsd,
    inputTokens,
    outputTokens,
    providerMs,
    bySplit,
    confusion,
    invalidLocations,
    falseConfidentInsufficient,
    classificationCandidate,
    independentReference: 'unverified',
    workflowEfficiency: 'unknown',
    note: 'This scores retained records against author labels; it cannot authenticate the export, certify the labels or prove review quality or time savings.',
  };
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  assert.equal(process.argv.length, 3, 'usage: node score.mjs <gateway-record-export.json>');
  const study = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  console.log(JSON.stringify(score(study), null, 2));
}
