import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { recordRecipeAttemptSelection } from '@farmslot/agent-runtime/scripts/retained-recipe-attempt.cjs';
import { digestRecipeDocument } from '@farmslot/protocol';
import { parseRecipeParamAssignments } from '@farmslot/recipe-runner/cli/support';

import { registerRecipeCommand, validateRecipeArtifactDirectory } from './recipe.js';

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
    result.recipe.findings.some(
      (finding) =>
        finding.code === 'artifact_package.summary_status_mismatch' && finding.severity === 'error',
    ),
  );
});

test('artifact inspection uses the protocol outcome for an explicitly partial run', async (t) => {
  const partialRecipe = {
    ...recipe,
    workflow: {
      entry: 'read',
      nodes: {
        read: {
          action: 'command',
          cmd: 'printf observed',
          intent: 'Read the local value',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  const artifactDir = await createArtifactPackage({
    metadata: { runner },
    entries: [
      {
        ...traceEntry,
        nodeId: 'read',
        action: 'command',
        intent: 'Read the local value',
        status: undefined,
        next: 'done',
        output: { stdout: 'observed', exitCode: 0 },
      },
    ],
  });
  t.after(() => rm(artifactDir, { recursive: true, force: true }));
  await writeJson(path.join(artifactDir, 'recipe.json'), partialRecipe);
  await writeJson(path.join(artifactDir, 'recipe-resolution.json'), {
    schema_version: 1,
    root: { ref: '$root', digest: digestRecipeDocument(partialRecipe) },
    dependencies: [],
    edges: [],
  });
  const summary = JSON.parse(await readFile(path.join(artifactDir, 'summary.json'), 'utf8'));
  await writeJson(path.join(artifactDir, 'summary.json'), {
    ...summary,
    status: 'unknown',
    stopAfterNode: 'read',
  });
  const manifest = JSON.parse(
    await readFile(path.join(artifactDir, 'artifact-manifest.json'), 'utf8'),
  );
  await writeJson(path.join(artifactDir, 'artifact-manifest.json'), {
    ...manifest,
    runStatus: 'unknown',
  });
  const result = await validateRecipeArtifactDirectory(artifactDir, {
    requireRunnerProvenance: true,
  });
  assert.equal(result.recipe.status, 'valid', JSON.stringify(result.recipe.findings));
  assert.ok(
    result.recipe.findings.some((finding) => finding.code === 'artifact_package.partial_run'),
  );
  assert.equal(result.status, 'pass', JSON.stringify(result.checks));
  assert.equal(result.liveEvidence, undefined);
  const live = await validateRecipeArtifactDirectory(artifactDir, {
    requireRunnerProvenance: true,
    liveProof: { smokeTarget: 'read', teardownTarget: 'cleanup' },
  });
  assert.equal(live.status, 'fail');
  assert.equal(live.liveEvidence, undefined);
  assert.match(
    live.checks.find((check) => check.id === 'runtime.proof')!.message,
    /Runtime recipe did not pass/u,
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
    result.recipe.findings.some(
      (finding) =>
        finding.code === 'artifact_package.summary_count_mismatch' && finding.severity === 'error',
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

test('public artifacts inspects, renders Markdown and refuses invalid provenance', async (t) => {
  const artifactDir = await createArtifactPackage({ metadata: { runner }, entries: [traceEntry] });
  const write = process.stdout.write;
  const previousExit = process.exitCode;
  let captured = '';
  t.after(async () => {
    process.stdout.write = write;
    process.exitCode = previousExit;
    await rm(artifactDir, { recursive: true, force: true });
  });
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  const invoke = async (flags: string[]) => {
    captured = '';
    process.exitCode = 0;
    const program = new Command().name('farmslot').option('--json').exitOverride();
    registerRecipeCommand(program);
    await program.parseAsync(['recipe', 'artifacts', artifactDir, ...flags], { from: 'user' });
    return captured;
  };
  const inspected = JSON.parse(await invoke(['--json', '--validate']));
  assert.equal(inspected.validation.status, 'pass');
  assert.equal(inspected.summary.status, 'pass');
  const markdown = await invoke(['--format', 'markdown']);
  assert.match(markdown, /- <code>trace.json<\/code>/u);
  await writeJson(path.join(artifactDir, 'trace.json'), {
    metadata: { runner: { ...runner, git_ref: 'other' } },
    entries: [traceEntry],
  });
  const invalid = JSON.parse(await invoke(['--json', '--validate']));
  assert.equal(invalid.validation.status, 'fail');
  assert.equal(process.exitCode, 1);
});

test('live artifact evidence refuses a passing package without runtime and cleanup assertions', async (t) => {
  const artifactDir = await createArtifactPackage({ metadata: { runner }, entries: [traceEntry] });
  t.after(() => rm(artifactDir, { recursive: true, force: true }));
  const result = await validateRecipeArtifactDirectory(artifactDir, {
    requireRunnerProvenance: true,
    liveProof: { smokeTarget: 'behavior', teardownTarget: 'cleanup' },
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.liveEvidence, undefined);
  assert.equal(result.checks.find((check) => check.id === 'runtime.proof')?.status, 'fail');
});

test('legacy artifact packages retain an explicit untimed warning', async (t) => {
  const root = await createArtifactPackage({ metadata: { runner }, entries: [traceEntry] });
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await validateRecipeArtifactDirectory(root, {});
  assert.equal(result.status, 'pass');
  assert.ok(
    result.recipe.findings.some(
      (f) => f.severity === 'warning' && /Legacy.*untimed/.test(f.message),
    ),
  );
});

test('recorded identity requires the retained claim package', async (t) => {
  const root = await createArtifactPackage({ metadata: { runner }, entries: [traceEntry] });
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'summary.json');
  const summary = JSON.parse(await readFile(file, 'utf8'));
  await writeJson(file, { ...summary, recipeRunId: 'retained-execution' });
  const result = await validateRecipeArtifactDirectory(root, {});
  assert.equal(result.status, 'fail');
  assert.ok(result.recipe.findings.some((f) => /retained claim package/.test(f.message)));
});

test('malformed present claims cannot disappear into legacy validation', async (t) => {
  const root = await createArtifactPackage({ metadata: { runner }, entries: [traceEntry] });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'acceptance-status.json'), '{');
  const result = await validateRecipeArtifactDirectory(root, {});
  assert.equal(result.status, 'fail');
  assert.ok(
    result.checks.some((c) => c.id === 'file.acceptance-status.json' && c.status === 'fail'),
  );
});

for (const selectedState of ['present', 'missing', 'outside', 'nested'] as const) {
  test(`task artifact inspection honors selected attempt (${selectedState}) over a legacy package`, async (t) => {
    const task = await mkdtemp(path.join(os.tmpdir(), 'artifacts-selection-'));
    const legacy = await createArtifactPackage({ metadata: { runner }, entries: [traceEntry] });
    const selected = await createArtifactPackage({ metadata: { runner }, entries: [traceEntry] });
    t.after(() => rm(task, { recursive: true, force: true }));
    t.after(() => rm(legacy, { recursive: true, force: true }));
    t.after(() => rm(selected, { recursive: true, force: true }));
    await mkdir(path.join(task, 'artifacts/recipe-runs'), { recursive: true });
    await rename(legacy, path.join(task, 'artifacts/recipe'));
    const attempt = path.join(task, 'artifacts/recipe-runs/attempt-2');
    await rename(selected, attempt);
    assert.equal(recordRecipeAttemptSelection(task, attempt), true);
    const pointer = path.join(task, 'artifacts/latest-valid-recipe-run.json');
    const before = await readFile(pointer, 'utf8');
    if (selectedState === 'nested') {
      await mkdir(path.join(attempt, 'artifacts'));
      await rename(path.join(task, 'artifacts/recipe'), path.join(attempt, 'artifacts/recipe'));
      await rm(path.join(attempt, 'artifact-manifest.json'));
    } else if (selectedState !== 'present') {
      if (selectedState === 'outside') {
        await rename(attempt, selected);
        await symlink(selected, attempt);
      } else await rm(attempt, { recursive: true });
    }
    let output = '';
    t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    });
    const previousExit = process.exitCode;
    t.after(() => {
      process.exitCode = previousExit;
    });
    process.exitCode = 0;
    const program = new Command().name('farmslot').option('--json').exitOverride();
    registerRecipeCommand(program);
    await program.parseAsync(['recipe', 'artifacts', task, '--json', '--validate'], {
      from: 'user',
    });
    const result = JSON.parse(output);
    if (selectedState === 'present') {
      assert.equal(process.exitCode, 0, output);
      assert.equal(result.artifactDir, attempt);
      assert.equal(result.validation.status, 'pass');
    } else {
      assert.equal(process.exitCode, 1, output);
      assert.match(
        result.error.message,
        selectedState === 'outside' ? /outside its root/ : /ENOENT/,
      );
    }
    assert.equal(await readFile(pointer, 'utf8'), before);
  });
}
