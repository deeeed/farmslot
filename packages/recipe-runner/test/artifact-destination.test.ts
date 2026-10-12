import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RECIPE_ACTION_MANIFEST_SCHEMA_URL } from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { createRecipeRunner } from '../src/core/runner.js';

const manifest = {
  $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  actions: { end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] } },
};
const recipe = {
  $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
  title: 'Retained evidence',
  description: 'One artifact package belongs to one attempt.',
  workflow: { entry: 'done', nodes: { done: { action: 'end', status: 'pass' } } },
};
const occupied = /already contains a retained attempt.*fresh artifactsDir or --artifacts-dir/u;

function runner() {
  return createRecipeRunner({
    actionManifest: manifest,
    adapters: createStandardCoreAdapters({ actions: ['end'] }),
    defaultSource: { kind: 'operator', trust: 'trusted' },
  });
}

test('reruns and preflight preserve published references and package bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'retained-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = path.join(root, 'attempt');
  const engine = runner();
  const request = { recipeDocument: recipe, projectRoot: root, artifactsDir };
  const first = await engine.run(request);
  const retained = await readFile(first.summaryPath);
  const reference = path.join(root, 'evidence-manifest.json');
  await writeFile(reference, JSON.stringify({ path: 'attempt/summary.json' }));
  const referenceBytes = await readFile(reference);
  await assert.rejects(engine.preflight(request), occupied);
  await assert.rejects(engine.run(request), occupied);
  assert.deepEqual(await readFile(first.summaryPath), retained);
  assert.deepEqual(await readFile(reference), referenceBytes);
  const fresh = await engine.run({ ...request, artifactsDir: path.join(root, 'attempt-2') });
  assert.equal(fresh.status, 'pass');
  assert.deepEqual(await readFile(first.summaryPath), retained);
});

test('partial packages refuse before recording starts and leave old bytes intact', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'partial-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let recordingStarts = 0;
  const engine = createRecipeRunner({
    actionManifest: manifest,
    adapters: createStandardCoreAdapters({ actions: ['end'] }),
    defaultSource: { kind: 'operator', trust: 'trusted' },
    recording: {
      targetProvider: { resolveRecordingTarget: async () => ({ kind: 'pid', pid: 1 }) },
      videoRecorder: {
        name: 'must-not-start',
        async start() {
          recordingStarts++;
          throw new Error('Recording must not start for an occupied destination.');
        },
      },
    },
  });
  for (const filename of [
    'recipe.json',
    'recipe-invocation.json',
    'recipe-resolution.json',
    'summary.json',
    'trace.json',
    'artifact-manifest.json',
    'evidence-manifest.json',
    'acceptance-status.json',
  ]) {
    const artifactsDir = path.join(root, filename);
    await mkdir(artifactsDir);
    const retainedPath = path.join(artifactsDir, filename);
    await writeFile(retainedPath, 'partial retained bytes');
    await assert.rejects(
      engine.run({ recipeDocument: recipe, artifactsDir, projectRoot: root, recordVideo: true }),
      occupied,
    );
    assert.equal(await readFile(retainedPath, 'utf8'), 'partial retained bytes');
  }
  assert.equal(recordingStarts, 0);
});

test('simultaneous executions admit one attempt without replacing its recipe', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'concurrent-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = path.join(root, 'attempt');
  const engine = runner();
  const recipes = [recipe, { ...recipe, title: 'Other attempt' }];
  const results = await Promise.allSettled(
    recipes.map((recipeDocument) =>
      engine.run({ recipeDocument, artifactsDir, projectRoot: root }),
    ),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const loser = results.find((result) => result.status === 'rejected');
  assert.ok(loser?.status === 'rejected');
  assert.match(String(loser.reason), occupied);
  const winner = results.findIndex((result) => result.status === 'fulfilled');
  assert.deepEqual(
    JSON.parse(await readFile(path.join(artifactsDir, 'recipe.json'), 'utf8')),
    recipes[winner],
  );
});

test('observer setup remains supported and preflight never creates a new destination', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'observer-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = path.join(root, 'attempt');
  const engine = runner();
  const request = { recipeDocument: recipe, artifactsDir, projectRoot: root };
  await engine.preflight(request);
  await assert.rejects(readFile(path.join(artifactsDir, 'recipe.json')), { code: 'ENOENT' });
  await mkdir(path.join(artifactsDir, 'network'), { recursive: true });
  await writeFile(path.join(artifactsDir, 'network', 'observer.json'), '{}');
  await engine.preflight(request);
  assert.equal((await engine.run(request)).status, 'pass');
  assert.equal(await readFile(path.join(artifactsDir, 'network', 'observer.json'), 'utf8'), '{}');
});

test('another path to a retained directory cannot admit a rerun', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alias-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = path.join(root, 'attempt');
  const engine = runner();
  await engine.run({ recipeDocument: recipe, artifactsDir, projectRoot: root });
  await symlink(artifactsDir, path.join(root, 'alias'));
  await assert.rejects(
    engine.run({
      recipeDocument: recipe,
      artifactsDir: path.join(root, 'alias'),
      projectRoot: root,
    }),
    occupied,
  );
});
