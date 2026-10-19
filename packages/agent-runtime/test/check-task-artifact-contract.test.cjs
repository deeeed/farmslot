#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
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
  writeFileSync(
    path.join(runDir, 'summary.json'),
    `${JSON.stringify({
      status: 'pass',
      total: 1,
      passed: 1,
      failed: 0,
      cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
    })}\n`,
  );
  writeFileSync(path.join(runDir, 'trace.json'), '[{"nodeId":"done","action":"end","ok":true}]\n');
  writeFileSync(path.join(artifactsDir, 'recipe-coverage.md'), '1/1 passed\n');
  return taskDir;
}

// Fresh-attempt selection must not fall back to an obsolete fixed package.
const selectionStarted = performance.now();
const selectedTask = makeTaskDir('farmslot-agent-selected-attempt-');
const selectedRoot = path.join(selectedTask, 'artifacts', 'recipe-runs', 'current');
try {
  mkdirSync(path.dirname(selectedRoot), { recursive: true });
  renameSync(path.join(selectedTask, 'artifacts', 'recipe-run'), selectedRoot);
  const { recordRecipeAttemptSelection } = require('../scripts/retained-recipe-attempt.cjs');
  assert.equal(recordRecipeAttemptSelection(selectedTask, selectedRoot), true);
  const selectedPointerPath = path.join(selectedTask, 'artifacts', 'latest-valid-recipe-run.json');
  const selectedPointer = readFileSync(selectedPointerPath);
  writeFileSync(path.join(selectedRoot, 'proof.png'), 'selected captured image');
  writeFileSync(
    path.join(selectedRoot, 'evidence-manifest.json'),
    JSON.stringify({
      version: 1,
      standalone: [{ label: 'Selected proof', file: 'proof.png' }],
    }),
  );
  writeFileSync(
    path.join(selectedTask, 'artifacts/evidence-manifest.json'),
    '{invalid old manifest',
  );
  const manifestContract = path.join(selectedTask, 'manifest-contract.json');
  writeFileSync(
    manifestContract,
    JSON.stringify({
      schemaVersion: 1,
      flowType: 'dev',
      recordedEvidenceContractVersion: 1,
      commands: { complete: { artifacts: ['artifacts/evidence-manifest.json'] } },
    }),
  );
  let selectedResult = spawnSync(
    process.execPath,
    [checker, selectedTask, '--contract', manifestContract, '--terminal', 'complete'],
    { encoding: 'utf8' },
  );
  assert.equal(selectedResult.status, 0, selectedResult.stderr);
  // The same old completed task keeps its declaration only under explicit contract 0.
  const attemptManifest = readFileSync(path.join(selectedRoot, 'evidence-manifest.json'));
  rmSync(path.join(selectedRoot, 'evidence-manifest.json'));
  writeFileSync(
    path.join(selectedTask, 'artifacts/evidence-manifest.json'),
    JSON.stringify({ version: 1, standalone: [] }),
  );
  const contract = JSON.parse(readFileSync(manifestContract, 'utf8'));
  contract.recordedEvidenceContractVersion = 0;
  writeFileSync(manifestContract, JSON.stringify(contract));
  selectedResult = spawnSync(
    process.execPath,
    [checker, selectedTask, '--contract', manifestContract, '--terminal', 'complete'],
    { encoding: 'utf8' },
  );
  assert.equal(selectedResult.status, 0, selectedResult.stderr);
  contract.recordedEvidenceContractVersion = 1;
  writeFileSync(manifestContract, JSON.stringify(contract));
  selectedResult = spawnSync(
    process.execPath,
    [checker, selectedTask, '--contract', manifestContract, '--terminal', 'complete'],
    { encoding: 'utf8' },
  );
  assert.equal(selectedResult.status, 1);
  assert.match(selectedResult.stderr, /evidence-manifest.json/);
  writeFileSync(path.join(selectedRoot, 'evidence-manifest.json'), attemptManifest);
  // QA placement is owned by its finalized case map, even with no managed pointer.
  const nested = path.join(selectedTask, 'artifacts/recipe-run/smoke-1');
  mkdirSync(path.dirname(nested), { recursive: true });
  renameSync(selectedRoot, nested);
  rmSync(selectedPointerPath);
  writeFileSync(
    path.join(selectedTask, 'artifacts/qa-result.json'),
    JSON.stringify({
      version: 1,
      packages: {
        smoke: 'recipe-run/smoke-1',
        conformance: 'conformance/attempt2/conformance/live/example',
      },
      smoke: { caseId: 'smoke', proofTarget: 'AC-1' },
    }),
  );
  writeFileSync(
    path.join(selectedTask, 'artifacts/evidence-manifest.json'),
    JSON.stringify({ version: 1, standalone: [] }),
  );
  selectedResult = spawnSync(process.execPath, [checker, selectedTask], { encoding: 'utf8' });
  assert.equal(selectedResult.status, 0, selectedResult.stderr);
  renameSync(nested, selectedRoot);
  writeFileSync(selectedPointerPath, selectedPointer);
  rmSync(path.join(selectedTask, 'artifacts/qa-result.json'));
  writeFileSync(path.join(selectedRoot, 'summary.json'), '{"status":"fail"}');
  assert.equal(recordRecipeAttemptSelection(selectedTask, selectedRoot), false);
  assert.deepEqual(readFileSync(selectedPointerPath), selectedPointer);
  writeFileSync(
    selectedPointerPath,
    JSON.stringify({ version: 1, relativeArtifactRoot: '../outside' }),
  );
  selectedResult = spawnSync(process.execPath, [checker, selectedTask], { encoding: 'utf8' });
  assert.equal(selectedResult.status, 1);
  assert.match(selectedResult.stderr, /Invalid retained recipe attempt selection/);
  console.log(
    `retained-attempt selection cases: ${(performance.now() - selectionStarted).toFixed(1)} ms`,
  );
} finally {
  rmSync(selectedTask, { recursive: true, force: true });
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
const validRecipeQualityTaskDir = taskDir;

taskDir = makeTaskDir('farmslot-agent-artifact-empty-recipe-quality-');
writeFileSync(path.join(taskDir, 'artifacts', 'recipe-quality.json'), '');
result = spawnSync(process.execPath, [checker, taskDir, '--require-recipe-quality-if-recipe'], {
  encoding: 'utf8',
});
assert.equal(result.status, 1);
assert.match(result.stderr, /recipe-quality\.json: invalid JSON/);

taskDir = makeTaskDir('farmslot-agent-artifact-empty-recipe-');
writeFileSync(path.join(taskDir, 'artifacts', 'recipe.json'), '');
result = spawnSync(process.execPath, [checker, taskDir], { encoding: 'utf8' });
assert.equal(result.status, 1);
assert.match(result.stderr, /recipe\.json: invalid JSON/);

// A WebP still is evidence media like a PNG one, so a missing one is caught.
taskDir = makeTaskDir('farmslot-agent-artifact-webp-still-');
writeFileSync(
  path.join(taskDir, 'artifacts', 'evidence-manifest.json'),
  JSON.stringify({
    version: 1,
    standalone: [{ label: 'Recorded still', file: 'recipe-run/stills/recorded-1.webp' }],
  }),
);
result = spawnSync(process.execPath, [checker, taskDir], { encoding: 'utf8' });
assert.equal(result.status, 1);
assert.match(
  result.stderr,
  /references missing artifact: artifacts\/recipe-run\/stills\/recorded-1\.webp/,
);
mkdirSync(path.join(taskDir, 'artifacts', 'recipe-run', 'stills'));
writeFileSync(path.join(taskDir, 'artifacts', 'recipe-run', 'stills', 'recorded-1.webp'), 'webp');
result = spawnSync(process.execPath, [checker, taskDir], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);

taskDir = makeTaskDir('farmslot-agent-artifact-empty-evidence-manifest-');
writeFileSync(path.join(taskDir, 'artifacts', 'evidence-manifest.json'), '');
result = spawnSync(process.execPath, [checker, taskDir], { encoding: 'utf8' });
assert.equal(result.status, 1);
assert.match(result.stderr, /evidence-manifest\.json: invalid JSON/);

result = spawnSync(
  process.execPath,
  [checker, validRecipeQualityTaskDir, '--require-recipe-quality-if-recipe'],
  {
    encoding: 'utf8',
    env: { ...process.env, FARMSLOT_TEST_DISABLE_RECIPE_PROTOCOL: '1' },
  },
);
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

taskDir = mkdtempSync(path.join(tmpdir(), 'farmslot-agent-recipe-decision-required-'));
mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
writeFileSync(
  path.join(taskDir, 'artifacts', 'recipe-decision.json'),
  `${JSON.stringify({
    version: 1,
    required: true,
    reason: 'A Core action exercises the changed behavior.',
    actionsChecked: ['metamask.perps.place_order'],
    claims: ['The rejected order is surfaced.'],
    recipePath: 'artifacts/recipe.json',
  })}\n`,
);
result = spawnSync(process.execPath, [checker, taskDir], { encoding: 'utf8' });
assert.equal(result.status, 1);
assert.match(result.stderr, /requires a recipe but artifacts\/recipe\.json is missing/);

const reviewerContractPath = path.join(taskDir, 'inputs', 'worker-terminal-contract.json');
mkdirSync(path.dirname(reviewerContractPath), { recursive: true });
writeFileSync(path.join(taskDir, 'artifacts', 'review-feedback.rev-claude.md'), '# ISSUES\n');
const reviewerContract = {
  schemaVersion: 1,
  flowType: 'review',
  requireSignal: true,
  commands: {
    complete: {
      report: 'artifacts/review-feedback.rev-claude.md',
      artifacts: ['artifacts/review-feedback.rev-claude.md'],
    },
    'no-change': {
      report: 'artifacts/review-feedback.rev-claude.md',
      artifacts: ['artifacts/review-feedback.rev-claude.md'],
    },
    blocked: { artifacts: [] },
  },
  whenPresent: [
    {
      path: 'artifacts/recipe.json',
      alsoRequire: ['artifacts/recipe-coverage.md'],
      requireRecipeQuality: true,
      requireRecipeCoverage: true,
    },
  ],
  resolvedAt: new Date().toISOString(),
  source: 'builtin',
};
writeFileSync(reviewerContractPath, `${JSON.stringify(reviewerContract)}\n`);
result = spawnSync(
  process.execPath,
  [checker, taskDir, '--contract', reviewerContractPath, '--terminal', 'complete'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 0, result.stderr);

writeFileSync(
  reviewerContractPath,
  `${JSON.stringify({ ...reviewerContract, flowType: 'review-fix' })}\n`,
);
result = spawnSync(
  process.execPath,
  [checker, taskDir, '--contract', reviewerContractPath, '--terminal', 'complete'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 1);
assert.match(result.stderr, /requires a recipe but artifacts\/recipe\.json is missing/);

taskDir = mkdtempSync(path.join(tmpdir(), 'farmslot-agent-recipe-decision-exempt-'));
mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
writeFileSync(
  path.join(taskDir, 'artifacts', 'recipe-decision.json'),
  `${JSON.stringify({
    version: 1,
    required: false,
    reason: 'No declared Core action reaches the changed build-only path.',
    actionsChecked: ['metamask.perps.read_markets'],
    claims: ['The generated declaration exports the corrected type.'],
  })}\n`,
);
result = spawnSync(process.execPath, [checker, taskDir], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);

taskDir = mkdtempSync(path.join(tmpdir(), 'farmslot-agent-recipe-decision-empty-'));
mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
writeFileSync(path.join(taskDir, 'artifacts', 'recipe-decision.json'), '');
result = spawnSync(process.execPath, [checker, taskDir], { encoding: 'utf8' });
assert.equal(result.status, 1);
assert.match(result.stderr, /recipe-decision\.json: invalid JSON/);

taskDir = mkdtempSync(path.join(tmpdir(), 'farmslot-agent-recipe-decision-blank-'));
mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
writeFileSync(
  path.join(taskDir, 'artifacts', 'recipe-decision.json'),
  `${JSON.stringify({
    version: 1,
    required: false,
    reason: 'No declared action reaches the changed build-only path.',
    actionsChecked: [''],
    claims: ['  '],
  })}\n`,
);
result = spawnSync(process.execPath, [checker, taskDir], { encoding: 'utf8' });
assert.equal(result.status, 1);
assert.match(result.stderr, /actionsChecked: expected non-empty string array/);
assert.match(result.stderr, /claims: expected non-empty string array/);

taskDir = mkdtempSync(path.join(tmpdir(), 'farmslot-agent-terminal-contract-missing-'));
mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
const missingContractPath = path.join(taskDir, 'missing-worker-terminal-contract.json');
result = spawnSync(
  process.execPath,
  [checker, taskDir, '--contract', missingContractPath, '--terminal', 'complete'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 1);
assert.match(result.stderr, /explicit worker terminal contract missing/);

process.stdout.write('agent-runtime artifact contract tests: ok\n');
