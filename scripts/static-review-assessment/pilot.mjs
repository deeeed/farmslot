#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { packet, verifyCorpus } from './check.mjs';
import { score } from './score.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function args(input) {
  const out = {};
  for (let i = 0; i < input.length; i++) {
    const key = input[i];
    if (key === '--fixture' || key === '--live' || key === '--export') {
      assert.equal(out.mode, undefined, 'choose one mode');
      out.mode = key.slice(2);
    } else if (['--out', '--admit', '--price-file'].includes(key)) {
      assert.equal(out[key], undefined, `duplicate ${key}`);
      out[key] = input[++i];
    } else throw new Error(`Unknown argument ${key}`);
  }
  assert.ok(['fixture', 'live', 'export'].includes(out.mode));
  assert.match(out['--out'], /^[\w.-]{1,80}$/);
  if (out.mode === 'live') {
    assert.match(out['--admit'], /^[a-f0-9]{64}$/);
    assert.ok(out['--price-file']);
  } else assert.ok(!out['--admit'] && !out['--price-file']);
  return out;
}

function priceSnapshot(input, provider, model, fixture) {
  assert.deepEqual(
    Object.keys(input).sort(),
    [
      'provider',
      'model',
      'source',
      'verifiedAt',
      'inputUsdPerMillion',
      'outputUsdPerMillion',
      'maxInputTokens',
      'maxOutputTokens',
    ].sort(),
  );
  const age = Date.now() - Date.parse(input.verifiedAt);
  assert.ok(fixture || (Number.isFinite(age) && age >= -60_000 && age <= 86400_000));
  assert.equal(input.provider, provider.id);
  assert.equal(input.model, model);
  assert.match(input.source, /^https:\/\/[^\s]+$/);
  assert.ok(Number.isFinite(input.inputUsdPerMillion) && input.inputUsdPerMillion > 0);
  assert.ok(Number.isFinite(input.outputUsdPerMillion) && input.outputUsdPerMillion >= 0);
  assert.ok(
    Number.isSafeInteger(input.maxInputTokens) &&
      input.maxInputTokens >= 8192 &&
      input.maxInputTokens <= 65536,
  );
  assert.ok(
    Number.isSafeInteger(input.maxOutputTokens) &&
      input.maxOutputTokens >= 1 &&
      input.maxOutputTokens <= 4096,
  );
  assert.ok(
    input.outputUsdPerMillion === 0 ||
      (provider.maxOutputTokens && provider.maxOutputTokens <= input.maxOutputTokens),
  );
  return { version: 1, ...input };
}

function priced(result, price, row, fixture) {
  const usage = result.usage;
  const matched = result.returnedModel === price.model && result.provider === price.provider;
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  const overLimit =
    input > price.maxInputTokens ||
    (price.outputUsdPerMillion > 0 && output > price.maxOutputTokens);
  const estimate =
    matched &&
    Number.isSafeInteger(input) &&
    input >= 0 &&
    (price.outputUsdPerMillion === 0 || (Number.isSafeInteger(output) && output >= 0))
      ? (input * price.inputUsdPerMillion + (output ?? 0) * price.outputUsdPerMillion) / 1_000_000
      : undefined;
  const pricedResult = {
    ...result,
    ...(usage
      ? {
          usage: {
            ...usage,
            costUsd: fixture && estimate !== undefined ? 0 : estimate,
            costKind: estimate === undefined ? undefined : 'estimated',
          },
        }
      : {}),
  };
  if (overLimit || (result.attempted && (!matched || estimate === undefined)))
    return {
      ...pricedResult,
      status: 'unavailable',
      answers: undefined,
      error: overLimit ? 'spend-bound-exceeded' : 'spend-bound-unverifiable',
    };
  if (result.status !== 'completed') return pricedResult;
  const answer = result.answers?.outcome;
  if (
    answer?.type !== 'choice' ||
    !Object.keys(packet(row).questions.outcome.criteria).includes(answer.choice)
  )
    return {
      ...pricedResult,
      status: 'unavailable',
      answers: undefined,
      error: 'Invalid static review response',
    };
  return pricedResult;
}

async function main() {
  const selected = args(process.argv.slice(2));
  const { cases, labels, hashes } = verifyCorpus();
  const base = path.resolve('temp');
  const dir = path.join(base, selected['--out']);
  if (selected.mode === 'export') {
    process.env.FARMSLOT_HOME = path.join(dir, 'home');
    const { assessmentRecords } = await import('../../services/gateway/src/assessment/store.ts');
    const metadata = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const study = { ...metadata, records: await assessmentRecords('static-review-pilot') };
    await writeFile(path.join(dir, 'study.json'), JSON.stringify(study, null, 2) + '\n');
    await writeFile(path.join(dir, 'report.json'), JSON.stringify(score(study), null, 2) + '\n');
    console.log(
      JSON.stringify({ dir, records: study.records.length, report: score(study) }, null, 2),
    );
    return;
  }
  const { assess } = await import('../../services/gateway/src/assessment/index.ts');
  const { prepareAssessmentInput } = await import('../../services/gateway/src/assessment/input.ts');
  const { reserveAssessment, assessmentRecords } =
    await import('../../services/gateway/src/assessment/store.ts');
  const { completeAssessment } = await import('../../services/gateway/src/assessment/monitor.ts');
  const { createAssessmentProviderRegistry } =
    await import('../../services/gateway/src/assessment/provider.ts');
  const { defaultAssessmentProviders } =
    await import('../../services/gateway/src/assessment/default-providers.ts');
  const { boundedAssessmentFetch } =
    await import('../../services/gateway/src/assessment/failure-triage/transport.ts');
  const fixture = selected.mode === 'fixture';
  if (!fixture)
    assert.equal(
      selected['--admit'],
      hashes['cases.v2.json'],
      'synthetic source admission mismatch',
    );
  const liveSnapshot = fixture
    ? undefined
    : JSON.parse(await readFile(selected['--price-file'], 'utf8'));
  const model = fixture ? 'fixture-1' : liveSnapshot.model;
  const providerId = fixture ? 'fixture' : liveSnapshot.provider;
  const byState = new Map(
    cases.cases.map((entry) => [
      hash(packet(entry).state),
      labels.labels.find((item) => item.id === entry.id),
    ]),
  );
  const registry = fixture
    ? createAssessmentProviderRegistry([
        {
          id: providerId,
          defaultModel: model,
          credentialEnv: 'FARMSLOT_STATIC_REVIEW_FIXTURE_KEY',
          capabilities: ['choice'],
          maxOutputTokens: 500,
          async assess(request) {
            const reference = byState.get(hash(request.state));
            assert.ok(reference, 'fixture received an unknown packet');
            return {
              returnedModel: model,
              answers: {
                outcome: {
                  type: 'choice',
                  choice:
                    reference.expected === 'violation'
                      ? `violation_${reference.locations[0]}`
                      : reference.expected,
                  choices: Object.keys(request.questions.outcome.criteria),
                },
              },
              usage: { inputTokens: 100, outputTokens: 30, durationMs: 1 },
            };
          },
        },
      ])
    : defaultAssessmentProviders(boundedAssessmentFetch(), fetch);
  if (fixture) process.env.FARMSLOT_STATIC_REVIEW_FIXTURE_KEY = 'synthetic-fixture-only';
  const provider = registry.get(providerId);
  assert.ok(
    provider && process.env[provider.credentialEnv]?.trim(),
    'configured provider credential required',
  );
  const snapshot = fixture
    ? {
        provider: providerId,
        model,
        source: 'https://example.com/fixture',
        verifiedAt: new Date().toISOString(),
        inputUsdPerMillion: 0.042,
        outputUsdPerMillion: 0,
        maxInputTokens: 8192,
        maxOutputTokens: 500,
      }
    : liveSnapshot;
  const price = priceSnapshot(snapshot, provider, model, fixture);
  const maxUsd =
    (price.maxInputTokens * price.inputUsdPerMillion +
      price.maxOutputTokens * price.outputUsdPerMillion) /
    1_000_000;
  assert.ok(maxUsd * cases.cases.length <= 0.01, 'batch reservation exceeds USD 0.01');
  const metadata = {
    version: 1,
    mode: selected.mode,
    corpusSha256: hashes['cases.v2.json'],
    labelsSha256: hashes['labels.v2.json'],
    provider: providerId,
    model,
    price,
    maxReservedUsd: maxUsd * cases.cases.length,
  };
  const prepared = cases.cases.map((row) => {
    const request = packet(row);
    const input = prepareAssessmentInput(
      request.state,
      request.questions,
      8192,
      process.env[provider.credentialEnv],
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(input)) * 2 + 4096 <= price.maxInputTokens,
      'input ceiling cannot cover provider wrapper',
    );
    return { row, input };
  });
  await mkdir(base, { recursive: true });
  await mkdir(dir); // Refuse a reused or partial batch; --export recovers existing receipts without another call.
  process.env.FARMSLOT_HOME = path.join(dir, 'home');
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n');
  for (const { row, input } of prepared) {
    const runId = row.id;
    const snapshotHash = hash(input.state);
    const reserved = await reserveAssessment(
      {
        ownerId: 'static-review-pilot',
        consumer: 'static-review-checklist',
        subject: {
          run: {
            id: runId,
            project: 'synthetic',
            step: 'static-review-checklist:v2',
            snapshotHash,
            admission: {
              classification: 'synthetic',
              sourceRef: `synthetic:static-review-v2/${row.id}`,
            },
          },
        },
        requestedIdentity: {
          provider: providerId,
          model,
          inputDigest: hash(input.state),
          questionSchemaHash: hash(input.questions),
        },
        policyVersion: 'static-review-checklist-pilot-v3',
      },
      {
        key: hash(['static-review-checklist-pilot-v3', runId, providerId, model, snapshotHash]),
        maxUsd,
        priceHash: hash(price),
        price: { ...price, maxRequestTokens: price.maxInputTokens + price.maxOutputTokens },
      },
      { maxCalls: 12, maxUsd: 0.01 },
    );
    assert.equal(reserved.status, 'reserved', `could not reserve ${row.id}`);
    await completeAssessment(reserved.record, async () =>
      priced(
        await assess(
          {
            enabled: true,
            state: input.state,
            questions: input.questions,
            provider: providerId,
            model,
            timeoutMs: 10000,
          },
          registry,
        ),
        price,
        row,
        fixture,
      ),
    );
  }
  const study = { ...metadata, records: await assessmentRecords('static-review-pilot') };
  await writeFile(path.join(dir, 'study.json'), JSON.stringify(study, null, 2) + '\n');
  const report = score(study);
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ dir, report }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'pilot failed');
  process.exitCode = 1;
});
