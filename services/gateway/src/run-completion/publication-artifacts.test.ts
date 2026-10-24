import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

await import('../runtime/mock-pty.test-support.js');
const {
  assertSelectedEvidencePublished,
  collectUploadableMediaFiles,
  expandEvidenceSelectionForManifest,
  filterArtifactUrlsByEvidenceSelection,
  scanArtifacts,
  resolvePublicationManifest,
  readSelectedPublicationManifest,
} = await import('./publication-artifacts.js');

test('the selected attempt preserves non-recipe declarations and missing selection never falls back', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'selected-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'artifacts/recipe-runs/current'), { recursive: true });
  await writeFile(
    path.join(root, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      relativeArtifactRoot: 'recipe-runs/current',
    }),
  );
  await writeFile(
    path.join(root, 'artifacts/evidence-manifest.json'),
    JSON.stringify({
      version: 1,
      standalone: [{ label: 'Old', file: 'old.png' }],
    }),
  );
  const selected = path.join(root, 'artifacts/recipe-runs/current/evidence-manifest.json');
  await writeFile(
    selected,
    JSON.stringify({
      version: 1,
      standalone: [{ label: 'Current', file: 'current.png' }],
    }),
  );
  const resolved = await resolvePublicationManifest(root);
  assert.equal(resolved?.sourcePath, 'artifacts/recipe-runs/current/evidence-manifest.json');
  assert.deepEqual(
    resolved?.manifest.standalone?.map((entry) => entry.file),
    ['old.png', 'artifacts/recipe-runs/current/current.png'],
  );
  assert.equal(resolved?.declarationSources?.[0]?.file, 'artifacts/evidence-manifest.json');
  await writeFile(selected, '{invalid');
  await assert.rejects(
    resolvePublicationManifest(root),
    /selected recipe attempt evidence-manifest.json is invalid/,
  );
  await rm(selected);
  await assert.rejects(resolvePublicationManifest(root), /selected recipe attempt has no/);
  await writeFile(path.join(root, 'artifacts/latest-valid-recipe-run.json'), '{invalid');
  await assert.rejects(
    resolvePublicationManifest(root),
    /selected recipe attempt pointer is invalid/,
  );
});

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
    await writeFile(path.join(taskDir, 'artifacts/runner-blockers/review-launch.txt'), 'pane');

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

test('completion refusal includes TAT-4259 field issues and preserves mirror fallback', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'invalid-publication-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'artifacts/recipe-runs/current'), { recursive: true });
  await writeFile(
    path.join(root, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      relativeArtifactRoot: 'recipe-runs/current',
    }),
  );
  const declaration = path.join(root, 'artifacts/evidence-manifest.json');
  const selected = path.join(root, 'artifacts/recipe-runs/current/evidence-manifest.json');
  const invalid = { preferred_mode: 'state', videos: [] };
  const assertFieldIssues = (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /manifest.preferred_mode: expected "screenshots" or "video"/);
    assert.match(error.message, /manifest.videos: expected object/);
    return true;
  };
  await writeFile(selected, JSON.stringify({ version: 1 }));
  await writeFile(declaration, JSON.stringify(invalid));
  await assert.rejects(resolvePublicationManifest(root), assertFieldIssues);
  assert.notEqual(await readSelectedPublicationManifest(root), null);
  await writeFile(declaration, JSON.stringify({ version: 1 }));
  await writeFile(selected, JSON.stringify(invalid));
  await assert.rejects(resolvePublicationManifest(root), assertFieldIssues);
  assert.equal(await readSelectedPublicationManifest(root), null);
  await writeFile(declaration, '{');
  await writeFile(selected, JSON.stringify({ version: 1 }));
  await assert.rejects(resolvePublicationManifest(root), /manifest: invalid JSON:/);
});
