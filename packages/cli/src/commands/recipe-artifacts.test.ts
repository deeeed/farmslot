import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { digestRecipeDocument } from '@farmslot/protocol';
import { parseRecipeParamAssignments } from '@farmslot/recipe-harness/cli/support';

import { validateRecipeArtifactDirectory } from './recipe.js';

const runner = {
  name: 'test-runner',
  source: 'packages/cli/src/commands/recipe-artifacts.test.ts',
  git_ref: 'test',
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const recipe = {
  $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
  title: 'Artifact validator fixture',
  description: 'Minimal artifact validator fixture.',
  workflow: {
    entry: 'done',
    nodes: {
      done: { action: 'end', status: 'pass' },
    },
  },
};

const traceEntry = {
  nodeId: 'done',
  action: 'end',
  startedAt: '2026-05-30T15:00:00Z',
  endedAt: '2026-05-30T15:00:01Z',
  durationMs: 1000,
  ok: true,
  status: 'pass',
};

test('parseRecipeParamAssignments keeps strings and parses JSON scalar values', () => {
  assert.deepEqual(
    parseRecipeParamAssignments(['market=ETH', 'enabled=false', 'count=0', 'label=']),
    { market: 'ETH', enabled: false, count: 0, label: '' },
  );
  assert.throws(() => parseRecipeParamAssignments(['market=ETH', 'market=BTC']), /more than once/);
  assert.throws(() => parseRecipeParamAssignments(['market']), /key=value/);
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function createArtifactPackage(
  trace: unknown,
  overrides: { summaryRunner?: unknown; manifestRunner?: unknown } = {},
): Promise<string> {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-artifacts-'));
  await writeJson(path.join(artifactDir, 'recipe.json'), recipe);
  await writeJson(path.join(artifactDir, 'recipe-resolution.json'), {
    schema_version: 1,
    root: { ref: '$root', digest: digestRecipeDocument(recipe) },
    dependencies: [],
    edges: [],
  });
  await writeJson(path.join(artifactDir, 'summary.json'), {
    status: 'pass',
    startedAt: '2026-05-30T15:00:00Z',
    completedAt: '2026-05-30T15:00:01Z',
    durationMs: 1000,
    total: 1,
    passed: 1,
    failed: 0,
    cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
    runner: overrides.summaryRunner ?? runner,
  });
  await writeJson(path.join(artifactDir, 'trace.json'), trace);
  await writeJson(path.join(artifactDir, 'artifact-manifest.json'), {
    version: 1,
    runStatus: 'pass',
    provenance: { runner: overrides.manifestRunner ?? runner },
    artifacts: [
      { path: 'summary.json', type: 'summary' },
      { path: 'trace.json', type: 'trace' },
      { path: 'recipe.json', type: 'recipe' },
    ],
  });
  return artifactDir;
}

test('committed documentation artifact packages validate', async () => {
  const artifactsRoot = path.join(repoRoot, 'docs', 'examples', 'recipes', 'farmslot', 'artifacts');
  for (const entry of await readdir(artifactsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const artifactDir = path.join(artifactsRoot, entry.name);
    const result = await validateRecipeArtifactDirectory(artifactDir, {});
    assert.equal(result.status, 'pass', `${entry.name}: ${JSON.stringify(result.recipe.findings)}`);
  }
});

test('validateRecipeArtifactDirectory requires matching runner provenance locations', async () => {
  const artifactDir = await createArtifactPackage({ metadata: { runner }, entries: [traceEntry] });
  const result = await validateRecipeArtifactDirectory(artifactDir, {
    recipe: path.join(artifactDir, 'recipe.json'),
    requireRunnerProvenance: true,
  });
  assert.equal(result.status, 'pass', JSON.stringify(result.checks));
  assert.equal(result.recipe.status, 'valid');
});

test('validateRecipeArtifactDirectory rejects empty runner provenance objects', async () => {
  const artifactDir = await createArtifactPackage(
    { metadata: { runner: {} }, entries: [traceEntry] },
    { summaryRunner: {}, manifestRunner: {} },
  );
  const result = await validateRecipeArtifactDirectory(artifactDir, {
    recipe: path.join(artifactDir, 'recipe.json'),
    requireRunnerProvenance: true,
  });
  assert.equal(result.status, 'fail');
  assert.deepEqual(
    result.checks.filter((check) => check.status === 'fail').map((check) => check.id),
    [
      'runner.provenance.summary',
      'runner.provenance.trace',
      'runner.provenance.manifest',
      'runner.provenance.matches',
    ],
  );
});

test('validateRecipeArtifactDirectory rejects mismatched runner provenance', async () => {
  const artifactDir = await createArtifactPackage({
    metadata: {
      runner: { ...runner, git_ref: 'different' },
    },
    entries: [traceEntry],
  });
  const result = await validateRecipeArtifactDirectory(artifactDir, {
    recipe: path.join(artifactDir, 'recipe.json'),
    requireRunnerProvenance: true,
  });
  assert.equal(result.status, 'fail');
  assert.deepEqual(
    result.checks.filter((check) => check.status === 'fail').map((check) => check.id),
    ['runner.provenance.matches'],
  );
});

test('validateRecipeArtifactDirectory rejects trace status that contradicts summary status', async () => {
  const artifactDir = await createArtifactPackage({
    metadata: { runner },
    entries: [{ ...traceEntry, ok: false, status: 'fail' }],
  });
  const result = await validateRecipeArtifactDirectory(artifactDir, {
    recipe: path.join(artifactDir, 'recipe.json'),
    requireRunnerProvenance: true,
  });
  assert.equal(result.status, 'fail');
  assert.ok(
    result.checks.some(
      (check) => check.id === 'trace.status_matches_summary' && check.status === 'fail',
    ),
  );
});

test('validateRecipeArtifactDirectory rejects trace counts that contradict summary counts', async () => {
  const artifactDir = await createArtifactPackage({
    metadata: { runner },
    entries: [traceEntry, { ...traceEntry, nodeId: 'extra', startedAt: '2026-05-30T15:00:01Z' }],
  });
  const result = await validateRecipeArtifactDirectory(artifactDir, {
    recipe: path.join(artifactDir, 'recipe.json'),
    requireRunnerProvenance: true,
  });
  assert.equal(result.status, 'fail');
  assert.ok(
    result.checks.some(
      (check) => check.id === 'trace.counts_match_summary' && check.status === 'fail',
    ),
  );
});

test('validateRecipeArtifactDirectory rejects manifest artifacts that are not present on disk', async () => {
  const artifactDir = await createArtifactPackage({ metadata: { runner }, entries: [traceEntry] });
  const manifestPath = path.join(artifactDir, 'artifact-manifest.json');
  await writeJson(manifestPath, {
    version: 1,
    runStatus: 'pass',
    provenance: { runner },
    artifacts: [
      { path: 'summary.json', type: 'summary' },
      { path: 'trace.json', type: 'trace' },
      { path: 'screenshots/missing.png', type: 'screenshot' },
    ],
  });

  const result = await validateRecipeArtifactDirectory(artifactDir, {
    recipe: path.join(artifactDir, 'recipe.json'),
    requireRunnerProvenance: true,
  });
  assert.equal(result.status, 'fail');
  assert.ok(
    result.recipe.findings.some(
      (finding) =>
        finding.code === 'artifact_manifest.missing_file' && finding.severity === 'error',
    ),
  );
});

test('dependency artifact reads are derived from the digest, not an untrusted path', async () => {
  const artifactDir = await createArtifactPackage({ metadata: { runner }, entries: [traceEntry] });
  const child = { ...recipe, title: 'Resolved child' };
  const digest = digestRecipeDocument(child);
  const escapedName = `outside-${path.basename(artifactDir)}.json`;
  await writeFile(path.join(artifactDir, '..', escapedName), 'outside sentinel', 'utf-8');
  await writeJson(path.join(artifactDir, 'recipe-resolution.json'), {
    schema_version: 1,
    root: { ref: '$root', digest: digestRecipeDocument(recipe) },
    dependencies: [
      {
        ref: 'child',
        source: 'test',
        file: 'recipes/child.recipe.json',
        digest,
        artifact: `../${escapedName}`,
      },
    ],
    edges: [{ from: '$root', to: 'child' }],
  });

  const result = await validateRecipeArtifactDirectory(artifactDir, {});
  assert.equal(result.status, 'fail');
  assert.ok(
    result.checks.some(
      (check) => check.id === `file.resolved-recipes/${digest.slice('sha256:'.length)}.recipe.json`,
    ),
  );
  assert.ok(!result.checks.some((check) => check.id.includes('..')));
});

test('artifact validation rejects file and directory symlink escapes', async () => {
  const artifactDir = await createArtifactPackage({ metadata: { runner }, entries: [traceEntry] });
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-artifacts-outside-'));
  const outsideSummary = path.join(outsideDir, 'summary.json');
  await writeJson(outsideSummary, { status: 'pass' });
  await rm(path.join(artifactDir, 'summary.json'));
  await symlink(outsideSummary, path.join(artifactDir, 'summary.json'));

  const fileEscape = await validateRecipeArtifactDirectory(artifactDir, {});
  assert.equal(fileEscape.status, 'fail');
  assert.ok(
    fileEscape.checks.some(
      (check) =>
        check.id === 'file.summary.json' &&
        check.status === 'fail' &&
        check.message.includes('resolves outside its root'),
    ),
  );

  const dependencyDir = await createArtifactPackage({
    metadata: { runner },
    entries: [traceEntry],
  });
  const child = { ...recipe, title: 'Symlinked child' };
  const digest = digestRecipeDocument(child);
  await writeJson(path.join(dependencyDir, 'recipe-resolution.json'), {
    schema_version: 1,
    root: { ref: '$root', digest: digestRecipeDocument(recipe) },
    dependencies: [
      {
        ref: 'child',
        source: 'test',
        file: 'recipes/child.recipe.json',
        digest,
        artifact: `resolved-recipes/${digest.slice('sha256:'.length)}.recipe.json`,
      },
    ],
    edges: [{ from: '$root', to: 'child' }],
  });
  await mkdir(path.join(outsideDir, 'resolved-recipes'), { recursive: true });
  await writeJson(
    path.join(outsideDir, 'resolved-recipes', `${digest.slice('sha256:'.length)}.recipe.json`),
    child,
  );
  await symlink(
    path.join(outsideDir, 'resolved-recipes'),
    path.join(dependencyDir, 'resolved-recipes'),
  );

  const directoryEscape = await validateRecipeArtifactDirectory(dependencyDir, {});
  assert.equal(directoryEscape.status, 'fail');
  assert.ok(
    directoryEscape.checks.some(
      (check) =>
        check.id === `file.resolved-recipes/${digest.slice('sha256:'.length)}.recipe.json` &&
        check.status === 'fail' &&
        check.message.includes('resolves outside its root'),
    ),
  );
});

test('validateRecipeArtifactDirectory rejects array traces when runner provenance is required', async () => {
  const artifactDir = await createArtifactPackage([traceEntry]);
  const result = await validateRecipeArtifactDirectory(artifactDir, {
    recipe: path.join(artifactDir, 'recipe.json'),
    requireRunnerProvenance: true,
  });
  assert.equal(result.status, 'fail');
  assert.deepEqual(
    result.checks.filter((check) => check.status === 'fail').map((check) => check.id),
    ['runner.provenance.trace', 'runner.provenance.matches'],
  );
});
