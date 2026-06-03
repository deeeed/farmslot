import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listRecipeRunArtifactGroupsForRun, loadLiveRecipeContextForRun } from './context.js';
import { makeRun } from './test-fixtures.js';

test('loadLiveRecipeContextForRun keeps video-only passing evidence', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-video-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const taskDir = path.join(root, 'tasks', 'video-evidence');
  const artifactsDir = path.join(taskDir, 'artifacts');
  const passingRunDir = path.join(artifactsDir, 'recipe-runs', 'passing-run');
  await mkdir(passingRunDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'passing-run',
      relativeArtifactRoot: 'recipe-runs/passing-run',
    }),
    'utf-8',
  );
  await writeFile(path.join(passingRunDir, 'before.mp4'), 'video', 'utf-8');
  await writeFile(path.join(passingRunDir, 'after.mp4'), 'video', 'utf-8');
  await writeFile(
    path.join(passingRunDir, 'summary.json'),
    JSON.stringify({ status: 'pass' }),
    'utf-8',
  );

  const run = makeRun(path.join(taskDir, 'TASK.md'));
  const context = await loadLiveRecipeContextForRun(run);
  assert.equal(context?.recipeRunId, 'passing-run');
  assert.equal(
    (context?.artifactManifest ?? []).filter(
      (artifact) => artifact.purpose === 'video-before' || artifact.purpose === 'video-after',
    ).length,
    2,
  );
});

test('loadLiveRecipeContextForRun keeps gif/webm-only passing evidence without summary artifacts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-animated-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const taskDir = path.join(root, 'tasks', 'animated-evidence');
  const artifactsDir = path.join(taskDir, 'artifacts');
  const passingRunDir = path.join(artifactsDir, 'recipe-runs', 'passing-run');
  await mkdir(passingRunDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'passing-run',
      relativeArtifactRoot: 'recipe-runs/passing-run',
    }),
    'utf-8',
  );
  await writeFile(path.join(passingRunDir, 'proof.gif'), 'gif', 'utf-8');
  await writeFile(path.join(passingRunDir, 'after.webm'), 'video', 'utf-8');

  const run = makeRun(path.join(taskDir, 'TASK.md'));
  const context = await loadLiveRecipeContextForRun(run);
  assert.equal(context?.recipeRunId, 'passing-run');
  assert.ok(
    (context?.artifactManifest ?? []).some(
      (artifact) => artifact.path === 'artifacts/proof.gif' && artifact.purpose === 'screenshot',
    ),
  );
  assert.ok(
    (context?.artifactManifest ?? []).some(
      (artifact) => artifact.path === 'artifacts/after.webm' && artifact.purpose === 'video-after',
    ),
  );
});

test('loadLiveRecipeContextForRun prefers explicit recipe-run-artifacts context over promoted pointer', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-live-explicit-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const taskDir = path.join(root, 'tasks', 'explicit-priority');
  const artifactsDir = path.join(taskDir, 'artifacts');
  const explicitRunDir = path.join(artifactsDir, 'recipe-runs', 'explicit-run');
  const promotedRunDir = path.join(artifactsDir, 'recipe-runs', 'promoted-run');
  await mkdir(explicitRunDir, { recursive: true });
  await mkdir(promotedRunDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(path.join(explicitRunDir, 'recipe.json'), '{"entry":"explicit"}', 'utf-8');
  await writeFile(
    path.join(explicitRunDir, 'summary.json'),
    JSON.stringify({ status: 'fail' }),
    'utf-8',
  );
  await writeFile(path.join(promotedRunDir, 'recipe.json'), '{"entry":"promoted"}', 'utf-8');
  await writeFile(
    path.join(promotedRunDir, 'summary.json'),
    JSON.stringify({ status: 'pass' }),
    'utf-8',
  );
  await writeFile(
    path.join(artifactsDir, 'latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'promoted-run',
      relativeArtifactRoot: 'recipe-runs/promoted-run',
    }),
    'utf-8',
  );

  const run = makeRun(path.join(taskDir, 'TASK.md'), {
    liveRecipeContext: {
      source: 'recipe-run-artifacts',
      recipeRunId: 'explicit-run',
      artifactRoot: explicitRunDir,
      artifactManifest: null,
      recipeJson: null,
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: null,
      isStale: false,
      selectionReason: 'user-selected',
    },
  });

  const context = await loadLiveRecipeContextForRun(run);
  assert.equal(context?.recipeRunId, 'explicit-run');
  assert.equal(context?.artifactRoot, explicitRunDir);
  assert.equal(context?.recipeJson, '{"entry":"explicit"}');
});

test('listRecipeRunArtifactGroupsForRun keeps bundle/live/promoted ordering and distinct ids', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-live-groups-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const taskDir = path.join(root, 'tasks', 'ordered-live');
  const artifactsDir = path.join(taskDir, 'artifacts');
  const liveRunDir = path.join(artifactsDir, 'recipe-runs', 'shared-run');
  const explicitLiveRunDir = path.join(liveRunDir, 'live-attempt');
  await mkdir(liveRunDir, { recursive: true });
  await mkdir(explicitLiveRunDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(path.join(artifactsDir, 'recipe.json'), '{"entry":"bundle"}\n', 'utf-8');
  await writeFile(
    path.join(liveRunDir, 'summary.json'),
    JSON.stringify({ status: 'pass' }),
    'utf-8',
  );
  await writeFile(
    path.join(explicitLiveRunDir, 'summary.json'),
    JSON.stringify({ status: 'running' }),
    'utf-8',
  );
  await writeFile(
    path.join(artifactsDir, 'latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'shared-run',
      relativeArtifactRoot: 'recipe-runs/shared-run',
    }),
    'utf-8',
  );

  const run = makeRun(path.join(taskDir, 'TASK.md'), {
    liveRecipeContext: {
      source: 'recipe-run-live',
      recipeRunId: 'shared-run',
      artifactRoot: explicitLiveRunDir,
      artifactManifest: [{ path: 'artifacts/summary.json', purpose: 'other' }],
      recipeJson: '{"entry":"live"}',
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: null,
      isStale: false,
      selectionReason: 'latest-run',
    },
  });

  const groups = await listRecipeRunArtifactGroupsForRun(run);
  assert.deepEqual(
    groups.map((group) => group.groupKind),
    ['current-artifacts', 'live-run', 'latest-valid'],
  );
  assert.equal(groups[0]?.recipeRunId, null);
  assert.equal(groups[1]?.id, 'live-run:shared-run');
  assert.equal(groups[1]?.recipeRunId, 'shared-run');
  assert.equal(groups[2]?.id, 'shared-run');
});
