#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..');
const checker = path.join(packageRoot, 'scripts', 'check-task-artifact-contract.mjs');

function makeTaskDir(name) {
  const taskDir = mkdtempSync(path.join(tmpdir(), name));
  const artifactsDir = path.join(taskDir, 'artifacts');
  const runDir = path.join(artifactsDir, 'recipe-run');
  mkdirSync(runDir, { recursive: true });
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Finish the task proof.',
    workflow: {
      entry: 'done',
      nodes: { done: { action: 'end', status: 'pass' } },
    },
  };
  const canonical = JSON.stringify(recipe, (_key, value) => {
    if (!value || Array.isArray(value) || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  });
  const digest = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
  writeFileSync(path.join(artifactsDir, 'recipe.json'), `${JSON.stringify(recipe)}\n`);
  writeFileSync(path.join(runDir, 'recipe.json'), `${JSON.stringify(recipe)}\n`);
  writeFileSync(
    path.join(runDir, 'recipe-resolution.json'),
    `${JSON.stringify({
      schema_version: 1,
      root: { ref: 'task', digest },
      dependencies: [],
      edges: [],
    })}\n`,
  );
  writeFileSync(
    path.join(runDir, 'artifact-manifest.json'),
    `${JSON.stringify({ version: 1, runStatus: 'pass', artifacts: [] })}\n`,
  );
  writeFileSync(path.join(runDir, 'summary.json'), '{"status":"pass"}\n');
  writeFileSync(path.join(runDir, 'trace.json'), '[{"nodeId":"done","action":"end","ok":true}]\n');
  writeFileSync(path.join(artifactsDir, 'recipe-coverage.md'), '1/1 passed\n');
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

result = spawnSync(process.execPath, [checker, taskDir, '--require-recipe-quality-if-recipe'], {
  encoding: 'utf8',
  env: { ...process.env, FARMSLOT_TEST_DISABLE_RECIPE_PROTOCOL: '1' },
});
assert.equal(result.status, 1);
assert.match(result.stderr, /requires built @farmslot\/protocol/);

taskDir = makeTaskDir('farmslot-agent-artifact-symlink-');
const outsideDir = mkdtempSync(path.join(tmpdir(), 'farmslot-agent-artifact-outside-'));
const childRecipe = {
  $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
  description: 'Finish the child proof.',
  workflow: {
    entry: 'done',
    nodes: { done: { action: 'end', status: 'pass' } },
  },
};
const childCanonical = JSON.stringify(childRecipe, (_key, value) => {
  if (!value || Array.isArray(value) || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
});
const childDigest = `sha256:${createHash('sha256').update(childCanonical).digest('hex')}`;
const outsideChild = path.join(outsideDir, 'child.recipe.json');
writeFileSync(outsideChild, `${JSON.stringify(childRecipe)}\n`);
mkdirSync(path.join(taskDir, 'artifacts', 'recipe-run', 'resolved-recipes'));
symlinkSync(
  outsideChild,
  path.join(
    taskDir,
    'artifacts',
    'recipe-run',
    'resolved-recipes',
    `${childDigest.slice('sha256:'.length)}.recipe.json`,
  ),
);
const rootRecipe = JSON.parse(readFileSync(path.join(taskDir, 'artifacts', 'recipe.json'), 'utf8'));
const rootCanonical = JSON.stringify(rootRecipe, (_key, value) => {
  if (!value || Array.isArray(value) || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
});
writeFileSync(
  path.join(taskDir, 'artifacts', 'recipe-run', 'recipe-resolution.json'),
  `${JSON.stringify({
    schema_version: 1,
    root: {
      ref: '$root',
      digest: `sha256:${createHash('sha256').update(rootCanonical).digest('hex')}`,
    },
    dependencies: [
      {
        ref: 'child',
        source: 'test',
        file: 'recipes/child.recipe.json',
        digest: childDigest,
        artifact: `resolved-recipes/${childDigest.slice('sha256:'.length)}.recipe.json`,
      },
    ],
    edges: [{ from: '$root', to: 'child' }],
  })}\n`,
);
result = spawnSync(process.execPath, [checker, taskDir], { encoding: 'utf8' });
assert.equal(result.status, 1);
assert.match(result.stderr, /resolves outside the task directory/i);

process.stdout.write('agent-runtime artifact contract tests: ok\n');
