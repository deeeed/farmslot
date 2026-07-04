#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..');
const checker = path.join(packageRoot, 'scripts', 'check-task-artifact-contract.mjs');

function makeTaskDir(name) {
  const taskDir = mkdtempSync(path.join(tmpdir(), name));
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(taskDir, 'artifacts', 'recipe.json'), '{"schema_version":1}\n');
  writeFileSync(path.join(taskDir, 'artifacts', 'recipe-coverage.md'), '1/1 passed\n');
  return taskDir;
}

let taskDir = makeTaskDir('farmslot-agent-artifact-invalid-');
writeFileSync(
  path.join(taskDir, 'artifacts', 'recipe-quality.json'),
  '{"version":1,"verdict":"pass","compact":{"verdict":"PASS"}}',
);
let result = spawnSync(process.execPath, [checker, taskDir, '--require-recipe-quality-if-recipe'], {
  encoding: 'utf8',
});
assert.equal(result.status, 1);
assert.match(result.stderr, /recipe-quality\.json: does not match RecipeQualityArtifact contract/);

taskDir = makeTaskDir('farmslot-agent-artifact-valid-');
writeFileSync(
  path.join(taskDir, 'artifacts', 'recipe-quality.json'),
  JSON.stringify({
    version: 1,
    verdict: 'pass',
    compact: {
      verdict: 'PASS',
      reasons: ['Recipe is covered.'],
      better_version_guidance: [],
    },
    dimensions: {},
    structural_findings: [],
    contextual_findings: [],
    suggested_recipe_delta: [],
    training_fields: { flow_type: 'fix-bug', proof_mode: 'mixed' },
    meta: {
      producer: 'worker',
      fallback_used: false,
      legacy_task: false,
      artifact_required: true,
      source_signals: ['recipe-quality.json'],
    },
  }),
);
result = spawnSync(process.execPath, [checker, taskDir, '--require-recipe-quality-if-recipe'], {
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);

process.stdout.write('agent-runtime artifact contract tests: ok\n');
