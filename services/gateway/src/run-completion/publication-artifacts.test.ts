import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { scanArtifacts } from './publication-artifacts.js';

test('scanArtifacts excludes runtime launch internals from reviewable manifests', async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-scan-artifacts-'));
  try {
    await mkdir(path.join(taskDir, 'artifacts/runtime-launch/chrome-profile'), { recursive: true });
    await mkdir(path.join(taskDir, 'artifacts/runtime-launch/runtime-dist'), { recursive: true });
    await mkdir(path.join(taskDir, 'artifacts/recipe-run'), { recursive: true });
    await writeFile(path.join(taskDir, 'artifacts/report.md'), 'ok');
    await writeFile(path.join(taskDir, 'artifacts/recipe-run/after.png'), 'png');
    await writeFile(path.join(taskDir, 'artifacts/runtime-launch/chrome-profile/Local State'), '{}');
    await writeFile(path.join(taskDir, 'artifacts/runtime-launch/runtime-dist/app.js'), 'bundle');

    const artifacts = await scanArtifacts(taskDir);

    assert.deepEqual(
      artifacts.map((artifact) => artifact.path).sort(),
      ['artifacts/recipe-run/after.png', 'artifacts/report.md'],
    );
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});
