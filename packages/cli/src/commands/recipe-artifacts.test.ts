import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateRecipeArtifactDirectory } from './recipe.js';

const runner = {
  name: 'test-runner',
  source: 'packages/cli/src/commands/recipe-artifacts.test.ts',
  git_ref: 'test',
};

const recipe = {
  schema_version: 1,
  title: 'Artifact validator fixture',
  description: 'Minimal artifact validator fixture.',
  validate: {
    workflow: {
      entry: 'done',
      nodes: {
        done: { action: 'end', intent: 'Complete fixture.', status: 'pass' },
      },
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function createArtifactPackage(
  trace: unknown,
  overrides: { summaryRunner?: unknown; manifestRunner?: unknown } = {},
): Promise<string> {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-artifacts-'));
  await writeJson(path.join(artifactDir, 'recipe.json'), recipe);
  await writeJson(path.join(artifactDir, 'summary.json'), {
    status: 'pass',
    startedAt: '2026-05-30T15:00:00Z',
    completedAt: '2026-05-30T15:00:01Z',
    durationMs: 1000,
    passed: 1,
    failed: 0,
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
