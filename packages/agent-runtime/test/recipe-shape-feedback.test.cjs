'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { collectShapeCatalog } = require('../scripts/recipe-shape-feedback.cjs');

test('configured and task-local catalogs use the frozen custom adapter without a manifest', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-shape-adapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const task = path.join(root, 'task'),
    lib = path.join(root, 'library');
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const recipe = {
    workflow: {
      entry: 'go',
      nodes: {
        go: { action: 'app.navigate', route: 'state', next: 'check' },
        check: { action: 'assert_output', contains: 'ready' },
      },
    },
  };
  write(path.join(task, 'inputs/recipe-binding.json'), {
    identity: { adapter: 'terminal', libraries: [{ name: 'proof', path: lib }] },
  });
  write(path.join(lib, 'recipes/terminal/observe.recipe.json'), recipe);
  write(path.join(lib, 'recipes/mobile/foreign.recipe.json'), recipe);
  write(path.join(task, 'artifacts/recipe-library/recipes/terminal/ac/ac1.recipe.json'), recipe);
  const catalog = collectShapeCatalog(task);
  assert.equal(catalog.adapter, 'terminal');
  assert.deepEqual(catalog.blocks.map((block) => block.ref).sort(), ['ac.ac1', 'proof.observe']);
});

test('Farm feedback teaches parameterization before completion and preserves core quality', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-shape-feedback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const task = path.join(root, 'task'),
    lib = path.join(root, 'library');
  fs.mkdirSync(path.join(task, 'inputs'), { recursive: true });
  fs.mkdirSync(path.join(task, 'artifacts'));
  fs.mkdirSync(path.join(lib, 'recipes/cli'), { recursive: true });
  const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  json(path.join(task, 'inputs/handoff.json'), {
    schemaVersion: 1,
    attemptId: 'shape-fixture',
    surface: 'farmslot',
    flow: 'dev',
    task: { acceptanceCriteria: ['The state is observed'] },
  });
  const identity = {
    libraries: [
      {
        name: 'proof',
        path: lib,
        head: null,
        sourceFingerprint: '1'.repeat(64),
        dirtyDigest: null,
      },
    ],
  };
  json(path.join(task, 'inputs/recipe-binding.json'), { identity });
  json(path.join(task, 'artifacts/harness-provenance.json'), { bindingIdentity: identity });
  json(path.join(lib, 'recipe-library.json'), { platforms: ['cli'] });
  json(path.join(lib, 'recipes/cli/observe.recipe.json'), {
    workflow: {
      entry: 'read',
      nodes: {
        read: { action: 'app.navigate', route: 'state', next: 'check' },
        check: { action: 'assert_output', source: 'read', contains: 'ready', next: 'done' },
        done: { action: 'end', status: 'pass' },
      },
    },
  });
  const recipe = {
    proofTargets: [{ id: 'AC-1', claim: 'The state is observed', proofMode: 'state' }],
    workflow: {
      entry: 'read',
      nodes: {
        read: { action: 'call', ref: 'proof.observe', params: { market: 'ETH' }, next: 'check' },
        check: {
          action: 'assert_output',
          source: 'read',
          contains: 'ready',
          proves: ['AC-1'],
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  const recipePath = path.join(task, 'artifacts/recipe.json');
  json(recipePath, recipe);
  const { buildRecipeQualityArtifact } = await import('../dist/recipe-quality.js');
  const base = buildRecipeQualityArtifact({
    verdict: 'pass',
    reasons: ['Existing structural verdict is retained'],
    producer: 'worker',
  });
  const output = path.join(task, 'artifacts/recipe-quality.json');
  json(output, base);
  const command = () =>
    spawnSync(
      process.execPath,
      [
        path.join(__dirname, '../bin/farmslot-agent.mjs'),
        'recipe-quality',
        'feedback',
        '--task',
        task,
        '--json',
      ],
      { encoding: 'utf8' },
    );
  let result = command();
  assert.equal(result.status, 0, result.stderr);
  let feedback = JSON.parse(result.stdout);
  assert.equal(feedback.parameterized, 0);
  assert.ok(feedback.hints.some((h) => h.field === 'read.params.market'));
  assert.equal(feedback.acCoverage.complete, true);
  let artifact = JSON.parse(fs.readFileSync(output, 'utf8'));
  const core = { ...artifact };
  delete core.shape;
  assert.deepEqual(core, base);
  const catalogPath = path.join(task, 'artifacts/recipe-shape-catalog.json');
  const catalogBefore = fs.statSync(catalogPath).ino;
  assert.equal(collectShapeCatalog(task).blocks[0].ref, 'proof.observe');
  recipe.paramsSchema = {
    type: 'object',
    properties: { market: { type: 'string', default: 'ETH' } },
  };
  recipe.workflow.nodes.read.params.market = '{{params.market}}';
  json(recipePath, recipe);
  result = command();
  assert.equal(result.status, 0, result.stderr);
  feedback = JSON.parse(result.stdout);
  assert.equal(feedback.parameterized, 1);
  assert.equal(feedback.eligibleForImitation, true);
  assert.equal(feedback.acCoverage.complete, true);
  assert.equal(
    fs.statSync(catalogPath).ino,
    catalogBefore,
    'unchanged declared catalog is not recopied',
  );
  artifact = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(artifact.verdict, 'pass');
  assert.equal(artifact.shape.status, 'ok');
  assert.equal(artifact.shape.catalog, undefined, 'full catalog is not embedded in the score');
  const qualityBefore = fs.statSync(output).ino;
  result = command();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(output).ino, qualityBefore, 'identical feedback is not rewritten');
});
