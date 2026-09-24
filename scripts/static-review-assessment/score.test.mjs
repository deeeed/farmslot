import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { packet, verifyCorpus } from './check.mjs';
import { score } from './score.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const { cases, labels, hashes } = verifyCorpus();
const reference = new Map(labels.labels.map((row) => [row.id, row]));

function study() {
  const price = {
    version: 1,
    provider: 'example',
    model: 'example-1',
    source: 'https://example.com/price',
    verifiedAt: '2026-09-24T00:00:00.000Z',
    inputUsdPerMillion: 0.042,
    outputUsdPerMillion: 0,
    maxInputTokens: 8192,
    maxOutputTokens: 500,
  };
  const perCallReserve = (8192 * 0.042) / 1_000_000;
  return {
    price,
    maxReservedUsd: perCallReserve * 12,
    version: 1,
    mode: 'live',
    corpusSha256: hashes['cases.v2.json'],
    labelsSha256: hashes['labels.v2.json'],
    provider: 'example',
    model: 'example-1',
    records: cases.cases.map((row, index) => {
      const { state, questions } = packet(row);
      const expected = reference.get(row.id);
      return {
        version: 1,
        id: `record-${index}`,
        consumer: 'static-review-checklist',
        ownerId: 'static-review-pilot',
        policyVersion: 'static-review-checklist-pilot-v3',
        status: 'completed',
        startedAt: '2026-09-24T00:00:00.000Z',
        completedAt: '2026-09-24T00:00:00.010Z',
        subject: {
          run: {
            id: row.id,
            project: 'synthetic',
            step: 'static-review-checklist:v2',
            snapshotHash: digest(state),
            admission: {
              classification: 'synthetic',
              sourceRef: `synthetic:static-review-v2/${row.id}`,
            },
          },
        },
        reservation: {
          key: digest([
            'static-review-checklist-pilot-v3',
            row.id,
            'example',
            'example-1',
            digest(state),
          ]),
          maxUsd: perCallReserve,
          priceHash: digest(price),
          price: { ...price, maxRequestTokens: 8692 },
        },
        requestedIdentity: {
          provider: 'example',
          model: 'example-1',
          inputDigest: digest(state),
          questionSchemaHash: digest(questions),
        },
        result: {
          status: 'completed',
          attempted: true,
          provider: 'example',
          requestedModel: 'example-1',
          returnedModel: 'example-1',
          answers: {
            outcome: {
              type: 'choice',
              choice:
                expected.expected === 'violation'
                  ? `violation_${expected.locations[0]}`
                  : expected.expected,
              choices: Object.keys(questions.outcome.criteria),
            },
          },
          usage: {
            inputTokens: 50,
            outputTokens: 10,
            durationMs: 5,
            costUsd: (50 * 0.042) / 1_000_000,
            costKind: 'estimated',
          },
        },
      };
    }),
  };
}

test('complete accurate records remain a candidate, not an independently verified pass', () => {
  const output = score(study());
  assert.equal(output.classificationCandidate, true);
  assert.equal(output.independentReference, 'unverified');
  assert.equal(output.workflowEfficiency, 'unknown');
  assert.equal(output.bySplit['held-out'].correct, 8);
});

test('repeated attempts and failures count toward cost without selecting a better result', () => {
  const input = study();
  const repeated = structuredClone(input.records[0]);
  repeated.id = 'retry';
  repeated.status = 'unavailable';
  repeated.result.status = 'unavailable';
  delete repeated.result.answers;
  input.records.push(repeated);
  const output = score(input);
  assert.equal(output.attempted, 13);
  assert.ok(Math.abs(output.costUsd - (13 * 50 * 0.042) / 1_000_000) < 1e-12);
  assert.equal(output.duplicates, 1);
  assert.equal(output.classificationCandidate, false);
});

test('a confident conclusion on omitted helper context fails the quality gate', () => {
  const input = study();
  const record = input.records.find((row) =>
    row.subject.run.admission.sourceRef.endsWith('case-ec428940a3'),
  );
  record.result.answers.outcome.choice = 'satisfied';
  const output = score(input);
  assert.equal(output.falseConfidentInsufficient, 1);
  assert.equal(output.classificationCandidate, false);
});

test('a failed, unaccounted or missing attempt cannot be treated as free or complete', () => {
  const input = study();
  input.records[0].status = 'interrupted';
  delete input.records[0].result;
  let output = score(input);
  assert.equal(output.unknownCharges, 1);
  assert.equal(output.classificationCandidate, false);
  input.records.shift();
  output = score(input);
  assert.equal(output.missingCases, 1);
  assert.equal(output.classificationCandidate, false);
});

test('an input digest mismatch cannot be counted as a scored case', () => {
  const input = study();
  input.records[0].requestedIdentity.inputDigest = 'wrong';
  assert.throws(() => score(input), { code: 'ERR_ASSERTION' });
});

test('malformed provider output stays visible and cannot qualify', () => {
  const input = study();
  input.records[0].result.answers.outcome.type = 'boolean';
  delete input.records[0].completedAt;
  const output = score(input);
  assert.equal(output.invalidOutputs, 1);
  assert.equal(output.missingEndToEnd, 1);
  assert.equal(output.classificationCandidate, false);
});

test('either causal line in the version-check change earns location credit', () => {
  const input = study();
  const record = input.records.find((row) =>
    row.subject.run.admission.sourceRef.endsWith('case-7ce42339e1'),
  );
  record.result.answers.outcome.choice = 'violation_L2';
  const output = score(input);
  assert.equal(output.invalidLocations, 0);
  assert.equal(output.bySplit['held-out'].correct, 8);
});

test('fixture transport can never qualify as provider quality', () => {
  const input = study();
  input.mode = 'fixture';
  assert.equal(score(input).classificationCandidate, false);
});
