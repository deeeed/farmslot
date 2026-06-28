import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { farmslotRoot } from '../fleet/state.js';

import {
  pruneRecipeRunHistory,
  refreshArtifactMirror,
  shouldClearLocalRecipeRunCache,
} from './artifact-mirror.js';
import { makeRun } from './test-fixtures.js';

test('refreshArtifactMirror preserves gateway-owned review artifacts while clearing stale worker files', async (t) => {
  const testId = `mirror-gateway-owned-${process.pid}-${Date.now()}`;
  const poolFile = path.join(farmslotRoot, 'pool', `${testId}.json`);
  const workerRepo = await mkdtemp(path.join(tmpdir(), `${testId}-worker-`));
  const taskRoot = path.join(farmslotRoot, '.sandbox/farmslot/tasks');
  const taskRelDir = `test/${testId}`;
  const taskDir = path.join(taskRoot, taskRelDir);
  const taskFile = path.join(taskDir, 'TASK.md');
  const workerTaskDir = path.join(workerRepo, '.sandbox/farmslot/worker-task', taskRelDir);
  const slotId = `${testId}-slot`;
  t.after(async () => {
    await rm(taskDir, { recursive: true, force: true });
    await rm(workerRepo, { recursive: true, force: true });
    await rm(poolFile, { force: true });
  });

  await mkdir(path.join(workerTaskDir, 'artifacts'), { recursive: true });
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(taskFile, '# mirror test\n');
  await writeFile(path.join(workerTaskDir, 'TASK.md'), '# mirror test\n');
  await writeFile(path.join(workerTaskDir, 'artifacts/report.md'), 'worker report\n');
  await writeFile(path.join(workerTaskDir, 'artifacts/after.png'), 'fresh worker image\n');
  await writeFile(path.join(workerTaskDir, 'artifacts/pr-package.json'), '{"worker":true}\n');
  await mkdir(path.join(workerTaskDir, 'artifacts/review-loop-1'), { recursive: true });
  await writeFile(path.join(workerTaskDir, 'artifacts/review-loop-1/review.diff'), 'worker diff\n');
  await writeFile(
    path.join(workerTaskDir, 'artifacts/latest-valid-recipe-run.json'),
    '{"version":1,"runId":"bad","relativeArtifactRoot":"../outside"}\n',
  );
  await mkdir(path.join(taskDir, 'artifacts/recipe-runs/cached-run'), { recursive: true });
  await writeFile(
    path.join(taskDir, 'artifacts/recipe-runs/cached-run/summary.json'),
    '{"status":"pass"}\n',
  );
  await mkdir(path.join(taskDir, 'artifacts/review-loop-1'), { recursive: true });
  await writeFile(path.join(taskDir, 'artifacts/review-loop-1/review.diff'), 'self diff\n');
  await writeFile(path.join(taskDir, 'artifacts/pr-package.json'), '{"gateway":true}\n');
  await mkdir(path.join(taskDir, 'artifacts/independent-review-2/review-loop-1'), {
    recursive: true,
  });
  await writeFile(path.join(taskDir, 'artifacts/independent-review-2.json'), '{}\n');
  await writeFile(path.join(taskDir, 'artifacts/independent-review-2.md'), '# Review\n');
  await writeFile(
    path.join(taskDir, 'artifacts/independent-review-2/review-loop-1/review.diff'),
    'diff\n',
  );
  await writeFile(path.join(taskDir, 'artifacts/publication-gate-hold-abc.md'), '# Hold\n');
  await writeFile(path.join(taskDir, 'artifacts/stale-worker-owned.png'), 'stale\n');
  await writeFile(
    poolFile,
    JSON.stringify(
      {
        machine: 'localhost',
        project: 'farmslot-farm',
        platform: 'cli',
        os: 'darwin',
        host: 'localhost',
        ssh_user: userInfo().username,
        slots: [{ id: slotId, enabled: true, repo: workerRepo, session: slotId }],
      },
      null,
      2,
    ),
  );

  const copied = await refreshArtifactMirror(
    makeRun({ id: testId, project: 'farmslot-farm', slotId, taskFile }),
  );

  assert.equal(copied >= 2, true);
  assert.equal(existsSync(path.join(taskDir, 'artifacts/after.png')), true);
  assert.equal(existsSync(path.join(taskDir, 'artifacts/independent-review-2.json')), true);
  assert.equal(existsSync(path.join(taskDir, 'artifacts/independent-review-2.md')), true);
  assert.equal(
    existsSync(path.join(taskDir, 'artifacts/recipe-runs/cached-run/summary.json')),
    true,
  );
  assert.equal(
    await readFile(path.join(taskDir, 'artifacts/review-loop-1/review.diff'), 'utf-8'),
    'self diff\n',
  );
  assert.equal(
    await readFile(path.join(taskDir, 'artifacts/pr-package.json'), 'utf-8'),
    '{"gateway":true}\n',
  );
  assert.equal(
    existsSync(path.join(taskDir, 'artifacts/independent-review-2/review-loop-1/review.diff')),
    true,
  );
  assert.equal(existsSync(path.join(taskDir, 'artifacts/publication-gate-hold-abc.md')), true);
  assert.equal(existsSync(path.join(taskDir, 'artifacts/stale-worker-owned.png')), false);
});

test('shouldClearLocalRecipeRunCache only clears when the worker pointer is truly absent', () => {
  assert.equal(shouldClearLocalRecipeRunCache(false, null), true);
  assert.equal(shouldClearLocalRecipeRunCache(true, null), false);
  assert.equal(
    shouldClearLocalRecipeRunCache(true, {
      version: 1,
      runId: 'keep-run',
      relativeArtifactRoot: 'recipe-runs/keep-run',
    }),
    false,
  );
});

test('refreshArtifactMirror rejects evidence-manifest references to internal artifacts', async (t) => {
  const testId = `mirror-internal-manifest-${process.pid}-${Date.now()}`;
  const poolFile = path.join(farmslotRoot, 'pool', `${testId}.json`);
  const workerRepo = await mkdtemp(path.join(tmpdir(), `${testId}-worker-`));
  const taskRoot = path.join(farmslotRoot, '.sandbox/farmslot/tasks');
  const taskRelDir = `test/${testId}`;
  const taskDir = path.join(taskRoot, taskRelDir);
  const taskFile = path.join(taskDir, 'TASK.md');
  const workerTaskDir = path.join(workerRepo, '.sandbox/farmslot/worker-task', taskRelDir);
  const slotId = `${testId}-slot`;
  t.after(async () => {
    await rm(taskDir, { recursive: true, force: true });
    await rm(workerRepo, { recursive: true, force: true });
    await rm(poolFile, { force: true });
  });

  await mkdir(path.join(workerTaskDir, 'artifacts/runtime-relaunch/chrome-profile'), {
    recursive: true,
  });
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(taskFile, '# mirror test\n');
  await writeFile(path.join(workerTaskDir, 'TASK.md'), '# mirror test\n');
  await writeFile(
    path.join(workerTaskDir, 'artifacts/evidence-manifest.json'),
    JSON.stringify({
      version: 1,
      standalone: [{ label: 'Internal', file: 'runtime-relaunch/chrome-profile/cache.png' }],
    }),
  );
  await writeFile(
    path.join(workerTaskDir, 'artifacts/runtime-relaunch/chrome-profile/cache.png'),
    'png',
  );
  await writeFile(
    poolFile,
    JSON.stringify(
      {
        machine: 'localhost',
        project: 'farmslot-farm',
        platform: 'cli',
        os: 'darwin',
        host: 'localhost',
        ssh_user: userInfo().username,
        slots: [{ id: slotId, enabled: true, repo: workerRepo, session: slotId }],
      },
      null,
      2,
    ),
  );

  await assert.rejects(
    () => refreshArtifactMirror(makeRun({ id: testId, project: 'farmslot-farm', slotId, taskFile })),
    /evidence-manifest references internal artifact: artifacts\/runtime-relaunch\/chrome-profile\/cache\.png/,
  );
  assert.equal(
    existsSync(path.join(taskDir, 'artifacts/runtime-relaunch/chrome-profile/cache.png')),
    false,
  );
});

test('pruneRecipeRunHistory skips symlinked recipe run entries', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-run-completion-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const artifactsDir = path.join(root, 'artifacts');
  const recipeRunsDir = path.join(artifactsDir, 'recipe-runs');
  const keepRunDir = path.join(recipeRunsDir, 'keep-run');
  const oldRunDir = path.join(recipeRunsDir, 'old-run');
  const externalDir = path.join(root, 'outside-run');
  await mkdir(keepRunDir, { recursive: true });
  await mkdir(oldRunDir, { recursive: true });
  await mkdir(externalDir, { recursive: true });
  await writeFile(path.join(oldRunDir, 'summary.json'), '{"status":"fail"}', 'utf-8');
  await writeFile(path.join(externalDir, 'sentinel.txt'), 'keep me', 'utf-8');
  await symlink(externalDir, path.join(recipeRunsDir, 'linked-run'));
  await writeFile(
    path.join(artifactsDir, 'latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'keep-run',
      relativeArtifactRoot: 'recipe-runs/keep-run',
    }),
    'utf-8',
  );

  await pruneRecipeRunHistory(artifactsDir);

  assert.equal(existsSync(keepRunDir), true);
  assert.equal(existsSync(oldRunDir), false);
  assert.equal(existsSync(path.join(recipeRunsDir, 'linked-run')), true);
  assert.equal(existsSync(path.join(externalDir, 'sentinel.txt')), true);
});

test('pruneRecipeRunHistory warns when latest-valid recipe-run pointer is invalid', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-run-completion-invalid-pointer-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const artifactsDir = path.join(root, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    path.join(artifactsDir, 'latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'bad-run',
      relativeArtifactRoot: '../outside',
    }),
    'utf-8',
  );

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown, ...rest: unknown[]) => {
    warnings.push([message, ...rest].map((part) => String(part)).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  await pruneRecipeRunHistory(artifactsDir);

  assert.ok(
    warnings.some((warning) => warning.includes('invalid latest valid recipe-run pointer')),
  );
});

test('pruneRecipeRunHistory keeps cached history when promoted run cache is missing', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-run-completion-missing-promoted-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const artifactsDir = path.join(root, 'artifacts');
  const recipeRunsDir = path.join(artifactsDir, 'recipe-runs');
  const oldRunDir = path.join(recipeRunsDir, 'old-run');
  const anotherRunDir = path.join(recipeRunsDir, 'another-run');
  await mkdir(oldRunDir, { recursive: true });
  await mkdir(anotherRunDir, { recursive: true });
  await writeFile(path.join(oldRunDir, 'summary.json'), '{"status":"pass"}', 'utf-8');
  await writeFile(path.join(anotherRunDir, 'summary.json'), '{"status":"fail"}', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'missing-run',
      relativeArtifactRoot: 'recipe-runs/missing-run',
    }),
    'utf-8',
  );

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown, ...rest: unknown[]) => {
    warnings.push([message, ...rest].map((part) => String(part)).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  await pruneRecipeRunHistory(artifactsDir);

  assert.equal(existsSync(oldRunDir), true);
  assert.equal(existsSync(anotherRunDir), true);
  assert.ok(warnings.some((warning) => warning.includes('promoted run cache is missing')));
});
