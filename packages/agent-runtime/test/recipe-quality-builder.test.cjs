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
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const stdoutArtifact = JSON.parse(result.stdout);
  assert.equal(stdoutArtifact.compact.reasons[0], 'All claims are covered.');
  assert.equal(stdoutArtifact.training_fields.proof_mode, 'trace');
  assert.equal(isRecipeQualityArtifact(stdoutArtifact), true);

  process.stdout.write('agent-runtime recipe-quality builder tests: ok\n');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
