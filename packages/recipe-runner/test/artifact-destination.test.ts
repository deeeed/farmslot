import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RECIPE_ACTION_MANIFEST_SCHEMA_URL } from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { createRecipeRunner } from '../src/core/runner.js';
import type { RecipeArtifactFinalization } from '../src/core/types.js';
import { validateRecordedEvidencePackage } from '../src/evidence/package.js';
import { readRecordedEvidencePackage } from '../src/evidence/read-package.js';

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

test('host closeout joins the single final package write and its validation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'finalized-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = path.join(root, 'attempt');
  let captured: RecipeArtifactFinalization | undefined;
  const result = await runner().run({
    recipeDocument: recipe,
    projectRoot: root,
    artifactsDir,
    finalizeArtifacts: async (context) => {
      captured = context;
      // Hosts cannot see an already-published summary/manifest to rewrite.
      await assert.rejects(access(context.result.summaryPath), { code: 'ENOENT' });
      await assert.rejects(access(context.result.artifactManifestPath), { code: 'ENOENT' });
      await writeFile(path.join(artifactsDir, 'closeout.json'), '{"closed":true}');
      context.register({ path: 'closeout.json', type: 'json', category: 'diagnostic' });
      context.annotateSummary({ recovered: ['runtime-ready'] });
      context.annotateManifest({ recovered: ['runtime-ready'] });
    },
  });
  const summaryBytes = await readFile(result.summaryPath);
  const manifestBytes = await readFile(result.artifactManifestPath);
  assert.deepEqual(JSON.parse(summaryBytes.toString()).recovered, ['runtime-ready']);
  assert.ok(
    JSON.parse(manifestBytes.toString()).artifacts.some(
      (entry: { path: string }) => entry.path === 'closeout.json',
    ),
  );
  const retained = await readRecordedEvidencePackage(artifactsDir);
  assert.ok(retained.checks.every((check) => check.status === 'pass'));
  assert.equal(validateRecordedEvidencePackage(retained.input).status, 'valid');
  assert.ok(captured);
  assert.throws(() => captured.annotateSummary({ recovered: [] }), /finalization has closed/u);
  assert.throws(
    () => captured.register({ path: 'late.json', type: 'json' }),
    /finalization has closed/u,
  );
  assert.deepEqual(await readFile(result.summaryPath), summaryBytes);
  assert.deepEqual(await readFile(result.artifactManifestPath), manifestBytes);
});

test('host artifact entries participate in final validation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'invalid-closeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    runner().run({
      recipeDocument: recipe,
      projectRoot: root,
      artifactsDir: path.join(root, 'attempt'),
      finalizeArtifacts: async (context) => {
        context.register({ path: '../outside.json', type: 'json' });
      },
    }),
    /Generated artifact package is invalid/u,
  );
});

test('closeout failure retains execution diagnostics and refuses success', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'failed-closeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = path.join(root, 'attempt');
  const failure = new Error('provider finalization failed');
  await assert.rejects(
    runner().run({
      recipeDocument: recipe,
      projectRoot: root,
      artifactsDir,
      finalizeArtifacts: async (context) => {
        await writeFile(path.join(artifactsDir, 'closeout.json'), '{"closed":false}');
        context.register({ path: 'closeout.json', type: 'json' });
        throw failure;
      },
    }),
    (error: unknown) => error === failure,
  );
  const retained = await readRecordedEvidencePackage(artifactsDir);
  assert.ok(retained.checks.every((check) => check.status === 'pass'));
  assert.equal(validateRecordedEvidencePackage(retained.input).status, 'valid');
  assert.ok(
    JSON.parse(
      await readFile(path.join(artifactsDir, 'artifact-manifest.json'), 'utf8'),
    ).artifacts.some((entry: { path: string }) => entry.path === 'closeout.json'),
  );
});
