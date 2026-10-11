import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertSelectedEvidencePublished,
  collectUploadableMediaFiles,
  expandEvidenceSelectionForManifest,
  filterArtifactUrlsByEvidenceSelection,
  scanArtifacts,
} from './publication-artifacts.js';

test('qualified upload and render selections do not include same-named older captures', () => {
  const urls = new Map([
    ['recipe-run/screenshots/before.png', 'https://example.invalid/current.png'],
    ['old/screenshots/before.png', 'https://example.invalid/old.png'],
  ]);
  assert.deepEqual(
    [
      ...filterArtifactUrlsByEvidenceSelection(urls, [
        'artifacts/recipe-run/screenshots/before.png',
      ]).keys(),
    ],
    ['recipe-run/screenshots/before.png'],
  );
  assert.throws(
    () =>
      assertSelectedEvidencePublished(
        ['artifacts/recipe-run/screenshots/before.png'],
        new Map([['old/screenshots/before.png', 'https://example.invalid/old.png']]),
      ),
    /missing/,
  );
  assert.throws(() => filterArtifactUrlsByEvidenceSelection(urls, ['before.png']), /ambiguous/);
  assert.deepEqual(
    expandEvidenceSelectionForManifest(
      {
        before_after_pairs: [
          {
            label: 'Current',
            before: 'recipe-run/screenshots/before.png',
            after: 'recipe-run/screenshots/after.png',
          },
        ],
      },
      ['old/screenshots/before.png'],
    ),
    ['artifacts/old/screenshots/before.png'],
  );
});

test('scanArtifacts retains package-relative recording timelines and rejects escaping metadata', async (t) => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-recording-artifacts-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  const dir = path.join(taskDir, 'artifacts/nested-proof');
  await mkdir(path.join(dir, 'videos'), { recursive: true });
  await writeFile(path.join(dir, 'videos/run.mp4'), 'recording fixture');
  await writeFile(path.join(dir, 'timing.json'), '{}');
  const entry = { path: 'videos/run.mp4', type: 'video', timelinePath: 'timing.json' };
  const manifest = path.join(dir, 'artifact-manifest.json');
  await writeFile(manifest, JSON.stringify({ version: 1, artifacts: [entry] }));
  let video = (await scanArtifacts(taskDir)).find((ref) => ref.path.endsWith('/run.mp4'))!;
  assert.equal(video.timelinePath, 'artifacts/nested-proof/timing.json');
  assert.match(video.sha256!, /^[a-f0-9]{64}$/);
  await writeFile(
    manifest,
    JSON.stringify({ version: 1, artifacts: [{ ...entry, timelinePath: '../timing.json' }] }),
  );
  video = (await scanArtifacts(taskDir)).find((ref) => ref.path.endsWith('/run.mp4'))!;
  assert.equal(video.timelinePath, undefined);
});

test('scanArtifacts excludes internal launch artifacts from reviewable manifests', async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-scan-artifacts-'));
  try {
    await mkdir(path.join(taskDir, 'artifacts/harness-launch'), { recursive: true });
    await mkdir(path.join(taskDir, 'artifacts/runtime-launch/chrome-profile'), { recursive: true });
    await mkdir(path.join(taskDir, 'artifacts/runtime-launch/runtime-dist'), { recursive: true });
    await mkdir(path.join(taskDir, 'artifacts/runtime-relaunch/runtime-dist'), { recursive: true });
    await mkdir(path.join(taskDir, 'artifacts/recipe-run'), { recursive: true });
    await mkdir(path.join(taskDir, 'artifacts/runner-blockers'), { recursive: true });
    await writeFile(path.join(taskDir, 'artifacts/report.md'), 'ok');
    await writeFile(path.join(taskDir, 'artifacts/recipe-run/after.png'), 'png');
    await writeFile(path.join(taskDir, 'artifacts/harness-launch/summary.json'), '{}');
    await writeFile(
      path.join(taskDir, 'artifacts/runtime-launch/chrome-profile/Local State'),
      '{}',
    );
    await writeFile(path.join(taskDir, 'artifacts/runtime-launch/runtime-dist/app.js'), 'bundle');
    await writeFile(path.join(taskDir, 'artifacts/runtime-relaunch/runtime-dist/app.js'), 'bundle');
    await writeFile(path.join(taskDir, 'artifacts/runner-blockers/self-review-launch.txt'), 'pane');

    const artifacts = await scanArtifacts(taskDir);

    assert.deepEqual(artifacts.map((artifact) => artifact.path).sort(), [
      'artifacts/recipe-run/after.png',
      'artifacts/report.md',
    ]);
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});

test('collectUploadableMediaFiles excludes internal launch artifact media', async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-upload-artifacts-'));
  try {
    const artifactsDir = path.join(taskDir, 'artifacts');
    await mkdir(path.join(artifactsDir, 'harness-launch'), { recursive: true });
    await mkdir(path.join(artifactsDir, 'runtime-launch/chrome-profile'), { recursive: true });
    await mkdir(path.join(artifactsDir, 'runtime-relaunch/chrome-profile'), { recursive: true });
    await mkdir(path.join(artifactsDir, 'runner-blockers'), { recursive: true });
    await mkdir(path.join(artifactsDir, 'recipe-run'), { recursive: true });
    await writeFile(path.join(artifactsDir, 'harness-launch/debug.png'), 'png');
    await writeFile(path.join(artifactsDir, 'runtime-launch/chrome-profile/cache.png'), 'png');
    await writeFile(path.join(artifactsDir, 'runtime-relaunch/chrome-profile/cache.png'), 'png');
    await writeFile(path.join(artifactsDir, 'runner-blockers/pane.png'), 'png');
    await writeFile(path.join(artifactsDir, 'recipe-run/after.png'), 'png');

    assert.deepEqual(await collectUploadableMediaFiles(artifactsDir), ['recipe-run/after.png']);
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});
