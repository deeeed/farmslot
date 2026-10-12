import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { ArtifactRef, Run } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const { readFrozenRecordedEvidenceSources } =
  await import('../run-engine/recorded-evidence-sources.js');
const { buildPackageEvidenceManifest } = await import('./package-evidence-manifest.js');
const { readFrozenPublicationManifest, verifyFrozenPublicationEvidence } =
  await import('./recorded-publication-evidence.js');
const { allSelectedEvidenceKeysForPublication, assertPublicationEvidenceSelection } =
  await import('./publication-evidence-policy.js');
const { expandPublicationEvidenceSelection, readEvidenceManifest } =
  await import('./publication-artifacts.js');

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function indexMedia(root: string, filename: string) {
  const manifestPath = path.join(root, 'artifact-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.artifacts.push({ path: filename, type: 'screenshot', label: 'Captured still' });
  await writeFile(manifestPath, JSON.stringify(manifest));
}

async function fixture(t: TestContext) {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'recorded-publication-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  const root = path.join(taskDir, 'artifacts/recipe-run');
  await mkdir(root, { recursive: true });
  await cp(
    new URL(
      '../../../../docs/examples/recipes/farmslot/artifacts/provenance-smoke/',
      import.meta.url,
    ),
    root,
    { recursive: true },
  );
  await writeFile(path.join(root, 'proof.png'), 'captured HUD image');
  await indexMedia(root, 'proof.png');
  const manifest = {
    version: 1,
    standalone: [{ label: 'Observed claim', file: 'recipe-run/proof.png' }],
  };
  await writeFile(path.join(taskDir, 'artifacts/evidence-manifest.json'), JSON.stringify(manifest));
  const artifacts: ArtifactRef[] = await Promise.all(
    (await readdir(root)).map(async (file) => ({
      path: `artifacts/recipe-run/${file}`,
      purpose: file === 'proof.png' ? 'screenshot' : 'other',
      sha256: digest(await readFile(path.join(root, file))),
    })),
  );
  const run = { id: 'retained-run', taskFile: path.join(taskDir, 'TASK.md') } as Run;
  return { taskDir, root, run, artifacts, manifest };
}

test('selected recorded media freezes the complete execution input and selection manifest', async (t) => {
  const { taskDir, run, root, artifacts, manifest } = await fixture(t);
  await mkdir(path.join(taskDir, 'artifacts/prior-attempt'));
  await writeFile(path.join(taskDir, 'artifacts/prior-attempt/summary.json'), '{}');
  artifacts.push({ path: 'artifacts/prior-attempt/summary.json', purpose: 'other' });
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  for (const file of await readdir(root))
    assert(inventory.some((entry) => entry.path === `artifacts/recipe-run/${file}`));
  assert(inventory.every((entry) => entry.sha256));
  assert(!inventory.some((entry) => entry.path.startsWith('artifacts/prior-attempt/')));
  assert.deepEqual(await readFrozenPublicationManifest(run, inventory), manifest);
  await verifyFrozenPublicationEvidence(run, inventory, ['artifacts/recipe-run/proof.png']);
  const sources = await readFrozenRecordedEvidenceSources(run, inventory, [
    'artifacts/recipe-run/proof.png',
  ]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.artifactPrefix, 'artifacts/recipe-run/');
});

test('replacing trace bytes is refused even when the selected media remains unchanged', async (t) => {
  const { taskDir, root, run, artifacts, manifest } = await fixture(t);
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  await writeFile(path.join(root, 'trace.json'), '[]');
  await assert.rejects(
    verifyFrozenPublicationEvidence(run, inventory, ['artifacts/recipe-run/proof.png']),
    /missing or changed.*trace.json/,
  );
});

test('selection manifest substitution and files added after approval cannot replace frozen facts', async (t) => {
  const { taskDir, root, run, artifacts, manifest } = await fixture(t);
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  const manifestPath = path.join(taskDir, 'artifacts/evidence-manifest.json');
  const originalManifest = await readFile(manifestPath);
  await writeFile(
    manifestPath,
    JSON.stringify({ version: 1, standalone: [{ label: 'New', file: 'recipe-run/new.png' }] }),
  );
  await assert.rejects(readFrozenPublicationManifest(run, inventory), /hash mismatch/);
  await writeFile(manifestPath, originalManifest);
  await writeFile(path.join(root, 'new.png'), 'new media');
  await indexMedia(root, 'new.png');
  await assert.rejects(
    verifyFrozenPublicationEvidence(run, inventory, ['artifacts/recipe-run/proof.png']),
    /missing or changed.*artifact-manifest.json/,
  );
});

test('legacy standalone media remains untimed without invented recipe dependencies', async (t) => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'legacy-publication-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  await mkdir(path.join(taskDir, 'artifacts'));
  await writeFile(path.join(taskDir, 'artifacts/proof.png'), 'old captured image');
  const run = { id: 'legacy', taskFile: path.join(taskDir, 'TASK.md') } as Run;
  const inventory = await buildPackageEvidenceManifest(
    taskDir,
    [{ path: 'artifacts/proof.png', purpose: 'screenshot' }],
    null,
  );
  assert.equal(inventory.length, 1);
  assert.equal(await readFrozenPublicationManifest(run, inventory), null);
  await verifyFrozenPublicationEvidence(run, inventory, ['artifacts/proof.png']);
});

test('a selection manifest changed between selection and freezing is refused', async (t) => {
  const { taskDir, artifacts, manifest } = await fixture(t);
  await writeFile(
    path.join(taskDir, 'artifacts/evidence-manifest.json'),
    JSON.stringify({
      ...manifest,
      standalone: [{ ...manifest.standalone[0], label: 'Changed selection' }],
    }),
  );
  await assert.rejects(
    buildPackageEvidenceManifest(taskDir, artifacts, manifest),
    /selection changed while preparing/,
  );
});

test('omitted media is frozen for validation without becoming selectable public evidence', async (t) => {
  const { taskDir, root, artifacts, manifest } = await fixture(t);
  await writeFile(path.join(root, 'private.png'), 'orientation still');
  await indexMedia(root, 'private.png');
  artifacts.push({ path: 'artifacts/recipe-run/private.png', purpose: 'screenshot' });
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  assert.equal(
    inventory.find((entry) => entry.path.endsWith('/private.png'))?.purpose,
    'evidence-dependency',
  );
  assert.deepEqual(allSelectedEvidenceKeysForPublication(inventory), [
    'artifacts/recipe-run/proof.png',
  ]);
  assert.throws(
    () =>
      assertPublicationEvidenceSelection({
        selectedEvidenceKeys: ['artifacts/recipe-run/private.png'],
        evidenceManifest: inventory,
        trustedEvidenceManifest: undefined,
      }),
    /none is selected/,
  );
});

test('an omitted paired image stays retained but never enters expanded publication selection', async (t) => {
  const { taskDir, root, artifacts } = await fixture(t);
  await writeFile(path.join(root, 'private.png'), 'before still omitted by author');
  await indexMedia(root, 'private.png');
  artifacts.push({ path: 'artifacts/recipe-run/private.png', purpose: 'screenshot' });
  const manifest = {
    version: 1,
    before_after_pairs: [
      { label: 'Change', before: 'recipe-run/private.png', after: 'recipe-run/proof.png' },
    ],
    omit: ['recipe-run/private.png'],
  };
  await writeFile(path.join(taskDir, 'artifacts/evidence-manifest.json'), JSON.stringify(manifest));
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  assert.deepEqual(
    expandPublicationEvidenceSelection({
      selectedEvidenceKeys: ['artifacts/recipe-run/proof.png'],
      evidenceManifest: inventory,
      trustedEvidenceManifest: manifest,
    }),
    ['artifacts/recipe-run/proof.png'],
  );
});

test('a headless task with an unrelated summary prepares an empty publication inventory', async (t) => {
  const { taskDir } = await fixture(t);
  await writeFile(path.join(taskDir, 'artifacts/summary.json'), '{}');
  assert.deepEqual(
    await buildPackageEvidenceManifest(
      taskDir,
      [{ path: 'artifacts/summary.json', purpose: 'summary' }],
      null,
    ),
    [],
  );
});

test('task-root preparation remains valid after gateway package files are written', async (t) => {
  const { taskDir, root, run } = await fixture(t);
  const artifactsDir = path.join(taskDir, 'artifacts');
  for (const file of await readdir(root))
    await rename(path.join(root, file), path.join(artifactsDir, file));
  await rm(root, { recursive: true });
  const manifest = { version: 1, standalone: [{ label: 'Root capture', file: 'proof.png' }] };
  await writeFile(path.join(artifactsDir, 'evidence-manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(artifactsDir, 'diff.txt'), 'gateway source diff');
  const artifacts = (await readdir(artifactsDir)).map((file) => ({
    path: `artifacts/${file}`,
    purpose: 'other',
  }));
  const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, manifest);
  for (const file of ['pr-package.json', 'pr-package.md'])
    await writeFile(path.join(artifactsDir, file), 'prepared package');
  await verifyFrozenPublicationEvidence(run, inventory, ['artifacts/proof.png']);
  assert(!inventory.some((entry) => entry.path.endsWith('/diff.txt')));
});

for (const location of ['promoted', 'inherited'] as const) {
  test(`${location} selection freezes normalized media paths and its original source`, async (t) => {
    const { taskDir, root, run, artifacts } = await fixture(t);
    const promotedRoot = path.join(taskDir, 'artifacts/recipe-runs/retained');
    await mkdir(path.dirname(promotedRoot), { recursive: true });
    await rename(root, promotedRoot);
    for (const artifact of artifacts)
      artifact.path = artifact.path.replace('recipe-run/', 'recipe-runs/retained/');
    await rm(path.join(taskDir, 'artifacts/evidence-manifest.json'));
    await writeFile(
      path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'),
      JSON.stringify({
        version: 1,
        runId: 'retained',
        relativeArtifactRoot: 'recipe-runs/retained',
      }),
    );
    const sourceDir =
      location === 'promoted' ? promotedRoot : path.join(taskDir, 'inputs/inherited');
    await mkdir(sourceDir, { recursive: true });
    const sourcePath = path.join(sourceDir, 'evidence-manifest.json');
    await writeFile(
      sourcePath,
      JSON.stringify({ version: 1, standalone: [{ label: 'Promoted proof', file: 'proof.png' }] }),
    );
    const effective = await readEvidenceManifest(run);
    const inventory = await buildPackageEvidenceManifest(taskDir, artifacts, effective);
    assert.deepEqual(
      await readFrozenPublicationManifest(run, inventory),
      JSON.parse(JSON.stringify(effective)),
    );
    assert.deepEqual(
      expandPublicationEvidenceSelection({
        selectedEvidenceKeys: ['artifacts/recipe-runs/retained/proof.png'],
        evidenceManifest: inventory,
        trustedEvidenceManifest: await readFrozenPublicationManifest(run, inventory),
      }),
      ['artifacts/recipe-runs/retained/proof.png'],
    );
    await verifyFrozenPublicationEvidence(run, inventory, [
      'artifacts/recipe-runs/retained/proof.png',
    ]);
    await writeFile(sourcePath, JSON.stringify({ version: 1, standalone: [] }));
    await assert.rejects(readFrozenPublicationManifest(run, inventory), /hash mismatch/);
  });
}
