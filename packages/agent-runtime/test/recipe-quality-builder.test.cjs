#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..');
const cli = path.join(packageRoot, 'bin', 'farmslot-agent.mjs');

async function main() {
  const distIndex = path.join(packageRoot, 'dist', 'index.js');
  const protocolDistIndex = path.resolve(packageRoot, '..', 'protocol', 'dist', 'index.js');
  const { buildRecipeQualityArtifact } = await import(`file://${distIndex}`);
  const { isRecipeQualityArtifact } = await import(`file://${protocolDistIndex}`);
  const builtViaApi = buildRecipeQualityArtifact({
    verdict: 'pass',
    reasons: ['API builder creates valid artifacts.'],
    trainingFields: { proof_mode: 'logs' },
  });
  assert.equal(builtViaApi.compact.verdict, 'PASS');
  assert.equal(builtViaApi.training_fields.proof_mode, 'logs');
  assert.equal(isRecipeQualityArtifact(builtViaApi), true);

  const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-recipe-quality-builder-'));
  const inputPath = path.join(dir, 'input.json');
  const outputPath = path.join(dir, 'artifacts', 'recipe-quality.json');

  writeFileSync(
    inputPath,
    JSON.stringify({
      verdict: 'warn',
      reasons: ['Recipe proves the main claim but misses teardown evidence.'],
      structuralFindings: [
        {
          code: 'missing-teardown-proof',
          message: 'Teardown cleanup is declared but not asserted.',
          evidence: ['recipe.json'],
        },
      ],
      suggestedRecipeDelta: ['Add a teardown assertion node.'],
      trainingFields: {
        project: 'farmslot-farm',
        flow_type: 'fix-bug',
        proof_mode: 'mixed',
      },
      extra: {
        reviewer_note: 'Additional producer-specific data is allowed.',
      },
    }),
  );

  let result = spawnSync(
    process.execPath,
    [cli, 'recipe-quality', 'build', '--input', inputPath, '--output', outputPath],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(artifact.version, 1);
  assert.equal(artifact.verdict, 'warn');
  assert.equal(artifact.compact.verdict, 'WARN');
  assert.equal(artifact.meta.producer, 'worker');
  assert.equal(artifact.meta.artifact_required, true);
  assert.equal(artifact.training_fields.project, 'farmslot-farm');
  assert.equal(artifact.reviewer_note, 'Additional producer-specific data is allowed.');
  assert.equal(isRecipeQualityArtifact(artifact), true);

  result = spawnSync(
    process.execPath,
    [
      cli,
      'recipe-quality',
      'build',
      '--verdict',
      'pass',
      '--reason',
      'All claims are covered.',
      '--proof-mode',
      'trace',
      '--legacy-task=false',
      '--claim-is-visual=false',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const stdoutArtifact = JSON.parse(result.stdout);
  assert.equal(stdoutArtifact.compact.reasons[0], 'All claims are covered.');
  assert.equal(stdoutArtifact.training_fields.proof_mode, 'trace');
  assert.equal(stdoutArtifact.meta.legacy_task, false);
  assert.equal(stdoutArtifact.training_fields.claim_is_visual, false);
  assert.equal(isRecipeQualityArtifact(stdoutArtifact), true);

  const mergeInputPath = path.join(dir, 'merge-input.json');
  writeFileSync(
    mergeInputPath,
    JSON.stringify({
      verdict: 'pass',
      reasons: ['Merge keeps file-provided training metadata.'],
      trainingFields: { project: 'farmslot-farm', flow_type: 'fix-bug', proof_mode: 'logs' },
    }),
  );
  result = spawnSync(
    process.execPath,
    [cli, 'recipe-quality', 'build', '--input', mergeInputPath, '--proof-mode', 'trace'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const mergedArtifact = JSON.parse(result.stdout);
  assert.equal(mergedArtifact.training_fields.project, 'farmslot-farm');
  assert.equal(mergedArtifact.training_fields.flow_type, 'fix-bug');
  assert.equal(mergedArtifact.training_fields.proof_mode, 'trace');
  assert.equal(isRecipeQualityArtifact(mergedArtifact), true);

  assert.throws(
    () =>
      buildRecipeQualityArtifact({
        verdict: 'nope',
        reasons: ['Invalid verdict is rejected.'],
      }),
    /verdict must be one of/,
  );

  assert.throws(
    () =>
      buildRecipeQualityArtifact({
        verdict: 'pass',
        reasons: ['Core keys must not be overridden.'],
        extra: { version: 99 },
      }),
    /extra.version cannot override/,
  );

  assert.throws(
    () =>
      buildRecipeQualityArtifact({
        verdict: 'pass',
        reasons: ['Training fields must be an object.'],
        trainingFields: 'oops',
      }),
    /trainingFields must be a JSON object/,
  );

  assert.throws(
    () =>
      buildRecipeQualityArtifact({
        verdict: 'pass',
        reasons: ['Extra must be an object.'],
        extra: 'oops',
      }),
    /extra must be a JSON object/,
  );

  assert.throws(
    () =>
      buildRecipeQualityArtifact({
        verdict: 'pass',
        reasons: ['Fallback metadata must be coherent.'],
        fallbackUsed: false,
        fallbackSource: 'fallback:recipe-json',
      }),
    /fallbackSource requires a fallback producer/,
  );

  assert.throws(
    () =>
      buildRecipeQualityArtifact({
        verdict: 'pass',
        reasons: ['Fallback source must be known.'],
        fallbackSource: 'bogus',
      }),
    /fallbackSource must be one of/,
  );

  assert.throws(
    () =>
      buildRecipeQualityArtifact({
        verdict: 'pass',
        reasons: ['Fallback producer must set fallback used.'],
        producer: 'fallback:report',
        fallbackUsed: false,
      }),
    /fallbackUsed cannot be false for fallback producers/,
  );

  assert.throws(
    () =>
      buildRecipeQualityArtifact({
        verdict: 'pass',
        reasons: ['Dimension errors are field-specific.'],
        dimensions: { graph: { status: 'bogus', reason: 'x', evidence: [] } },
      }),
    /dimensions\.graph\.status must be one of/,
  );

  assert.throws(
    () =>
      buildRecipeQualityArtifact({
        verdict: 'pass',
        reasons: ['Finding errors are field-specific.'],
        structuralFindings: [{ code: 'x' }],
      }),
    /structuralFindings\.0\.message must be a string/,
  );

  assert.throws(
    () =>
      buildRecipeQualityArtifact({
        verdict: 'pass',
        reasons: ['Booleans must be booleans.'],
        legacyTask: 'false',
      }),
    /legacyTask must be a boolean/,
  );

  result = spawnSync(
    process.execPath,
    [cli, 'recipe-quality', 'build', '--verdict', 'nope', '--reason', 'Invalid verdict.'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verdict must be one of/);

  result = spawnSync(
    process.execPath,
    [
      cli,
      'recipe-quality',
      'build',
      '--verdict',
      'pass',
      '--reason',
      'Bad proof.',
      '--proof-mode',
      'bogus',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /trainingFields\.proof_mode must be one of/);

  result = spawnSync(process.execPath, [cli, 'recipe-quality', 'build', '--input', '-'], {
    encoding: 'utf8',
    input: JSON.stringify({ verdict: 'pass', reasons: ['bad'], trainingFields: 'oops' }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /trainingFields must be a JSON object/);

  const typoInputPath = path.join(dir, 'typo-input.json');
  writeFileSync(
    typoInputPath,
    JSON.stringify({
      verdict: 'pass',
      reasons: ['Typos should fail loudly.'],
      sugested_recipe_delta: ['typo'],
    }),
  );
  result = spawnSync(process.execPath, [cli, 'recipe-quality', 'build', '--input', typoInputPath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown key\(s\): sugested_recipe_delta/);

  const compactConflictInputPath = path.join(dir, 'compact-conflict-input.json');
  writeFileSync(
    compactConflictInputPath,
    JSON.stringify({
      verdict: 'pass',
      compact: { verdict: 'FAIL', reasons: ['conflict'], better_version_guidance: [] },
    }),
  );
  result = spawnSync(
    process.execPath,
    [cli, 'recipe-quality', 'build', '--input', compactConflictInputPath],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /compact\.verdict is output-only/);

  const compactReasonConflictInputPath = path.join(dir, 'compact-reason-conflict-input.json');
  writeFileSync(
    compactReasonConflictInputPath,
    JSON.stringify({
      verdict: 'pass',
      reasons: ['top-level'],
      compact: { reasons: ['compact'], better_version_guidance: [] },
    }),
  );
  result = spawnSync(
    process.execPath,
    [cli, 'recipe-quality', 'build', '--input', compactReasonConflictInputPath],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reasons conflicts with compact\.reasons/);

  const metaTypoInputPath = path.join(dir, 'meta-typo-input.json');
  writeFileSync(
    metaTypoInputPath,
    JSON.stringify({ verdict: 'pass', reasons: ['meta typo'], meta: { produtser: 'worker' } }),
  );
  result = spawnSync(
    process.execPath,
    [cli, 'recipe-quality', 'build', '--input', metaTypoInputPath],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /meta contains unknown key\(s\): produtser/);

  const badProducerInputPath = path.join(dir, 'bad-producer-input.json');
  writeFileSync(
    badProducerInputPath,
    JSON.stringify({ verdict: 'pass', reasons: ['Bad producer.'], producer: 123 }),
  );
  result = spawnSync(
    process.execPath,
    [cli, 'recipe-quality', 'build', '--input', badProducerInputPath],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /producer must be one of/);

  result = spawnSync(process.execPath, [cli, 'recipe-quality', 'build', '--bogus'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option --bogus/);

  result = spawnSync(
    process.execPath,
    [cli, 'recipe-quality', 'build', '--artifact-required=bogus'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--artifact-required must be true or false/);

  result = spawnSync(process.execPath, [cli, 'recipe-quality', 'build', '--legacy-task=bogus'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--legacy-task must be true or false/);

  process.stdout.write('agent-runtime recipe-quality builder tests: ok\n');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
