import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectUploadableMediaFiles, scanArtifacts } from './publication-artifacts.js';

test('scanArtifacts excludes runtime launch and runner blocker internals from reviewable manifests', async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-scan-artifacts-'));
  try {
    await mkdir(path.join(taskDir, 'artifacts/runtime-launch/chrome-profile'), { recursive: true });
    await mkdir(path.join(taskDir, 'artifacts/runtime-launch/runtime-dist'), { recursive: true });
    await mkdir(path.join(taskDir, 'artifacts/recipe-run'), { recursive: true });
    await mkdir(path.join(taskDir, 'artifacts/runner-blockers'), { recursive: true });
    await writeFile(path.join(taskDir, 'artifacts/report.md'), 'ok');
    await writeFile(path.join(taskDir, 'artifacts/recipe-run/after.png'), 'png');
    await writeFile(path.join(taskDir, 'artifacts/runtime-launch/chrome-profile/Local State'), '{}');
    await writeFile(path.join(taskDir, 'artifacts/runtime-launch/runtime-dist/app.js'), 'bundle');
    await writeFile(path.join(taskDir, 'artifacts/runner-blockers/self-review-launch.txt'), 'pane');

    const artifacts = await scanArtifacts(taskDir);

    assert.deepEqual(
      artifacts.map((artifact) => artifact.path).sort(),
      ['artifacts/recipe-run/after.png', 'artifacts/report.md'],
    );
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});

test('collectUploadableMediaFiles excludes runtime launch and runner blocker media', async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-upload-artifacts-'));
  try {
    const artifactsDir = path.join(taskDir, 'artifacts');
    await mkdir(path.join(artifactsDir, 'runtime-launch/chrome-profile'), { recursive: true });
    await mkdir(path.join(artifactsDir, 'runner-blockers'), { recursive: true });
    await mkdir(path.join(artifactsDir, 'recipe-run'), { recursive: true });
    await writeFile(path.join(artifactsDir, 'runtime-launch/chrome-profile/cache.png'), 'png');
    await writeFile(path.join(artifactsDir, 'runner-blockers/pane.png'), 'png');
    await writeFile(path.join(artifactsDir, 'recipe-run/after.png'), 'png');

    assert.deepEqual(await collectUploadableMediaFiles(artifactsDir), ['recipe-run/after.png']);
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});
