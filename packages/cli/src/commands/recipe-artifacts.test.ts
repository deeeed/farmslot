import assert from 'node:assert/strict';
import {
  link,
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
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import { recordRecipeAttemptSelection } from '@farmslot/agent-runtime/scripts/retained-recipe-attempt.cjs';
import { digestRecipeDocument } from '@farmslot/protocol';
import { validateRecipeArtifactDirectory, writeRunReport } from '@farmslot/recipe-cli/harness';
import { createRecipeRunner } from '@farmslot/recipe-runner';
import { parseRecipeParamAssignments } from '@farmslot/recipe-runner/cli/support';

import { registerRecipeCommand } from './recipe.js';

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
        selectedState === 'nested' ? /ENOENT/ : /outside its root/,
      );
    }
    assert.equal(await readFile(pointer, 'utf8'), before);
  });
}

function artifactInvocation(
  t: TestContext,
  directory: string,
): (flags: string[]) => Promise<string> {
  let captured = '';
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    captured += chunk.toString();
    return true;
  });
  const previousExit = process.exitCode;
  t.after(() => {
    process.exitCode = previousExit;
  });
  return async (flags) => {
    captured = '';
    process.exitCode = 0;
    const program = new Command().name('farmslot').option('--json').exitOverride();
    registerRecipeCommand(program);
    await program.parseAsync(['recipe', 'artifacts', directory, ...flags], { from: 'user' });
    return captured;
  };
}

test('authored static Markdown renders to stdout or explicit output, without inventing validation', async (t) => {
  const task = await mkdtemp(path.join(os.tmpdir(), 'static-markdown-'));
  t.after(() => rm(task, { recursive: true, force: true }));
  const artifacts = path.join(task, 'artifacts');
  await mkdir(artifacts);
  await writeFile(
    path.join(artifacts, 'pr-description.md'),
    '## Description\n\nStatic source change.\n',
  );
  const invoke = artifactInvocation(t, task);
  const body = await invoke(['--format', 'markdown']);
  assert.match(body, /Static source change\./);
  assert.match(body, /Not applicable: no recipe run report/);
  assert.deepEqual(await readdir(artifacts), ['pr-description.md']);
  const out = path.join(artifacts, 'pr-body.md');
  const json = JSON.parse(await invoke(['--format', 'markdown', '--out', out, '--json']));
  assert.equal(json.out, out);
  assert.equal(json.body, undefined);
  assert.equal(await readFile(out, 'utf8'), body);
  assert.deepEqual(json.sections, ['## **Validation Recipe**', '## **Validation Logs**']);
  assert.equal(json.manifest, undefined);
  await rm(out);
  const refused = JSON.parse(
    await invoke(['--format', 'markdown', '--validate', '--out', out, '--json']),
  );
  assert.equal(process.exitCode, 1);
  assert.match(JSON.stringify(refused), /No retained artifact package/);
  await assert.rejects(readFile(out), { code: 'ENOENT' });
  const wrongFormat = JSON.parse(await invoke(['--out', out, '--json']));
  assert.match(JSON.stringify(wrongFormat), /require --format markdown/);
  await assert.rejects(readFile(out), { code: 'ENOENT' });
});

test('authored Markdown preserves selected package provenance and refuses evidence overwrite', async (t) => {
  const task = await mkdtemp(path.join(os.tmpdir(), 'selected-markdown-'));
  const original = await createArtifactPackage({ metadata: { runner }, entries: [traceEntry] });
  t.after(() => rm(task, { recursive: true, force: true }));
  t.after(() => rm(original, { recursive: true, force: true }));
  const artifacts = path.join(task, 'artifacts');
  await mkdir(path.join(artifacts, 'recipe-runs'), { recursive: true });
  const selected = path.join(artifacts, 'recipe-runs/selected');
  await rename(original, selected);
  await writeFile(path.join(artifacts, 'pr-description.md'), '## Description\n\nAuthored PR.\n');
  await writeFile(path.join(artifacts, 'recipe.json'), '{broken stale draft');
  await writeFile(
    path.join(selected, 'report.md'),
    'Status: pass\nNodes: 1/1 passed\nSELECTED_PROOF\n',
  );
  assert.equal(recordRecipeAttemptSelection(task, selected), true);
  const pointer = await readFile(path.join(artifacts, 'latest-valid-recipe-run.json'), 'utf8');
  const invoke = artifactInvocation(t, task);
  const json = JSON.parse(
    await invoke([
      '--format',
      'markdown',
      '--validate',
      '--command',
      'farmslot recipe run task/recipe.json',
      '--json',
    ]),
  );
  assert.equal(json.artifactDir, selected);
  assert.deepEqual(json.manifest.provenance.runner, runner);
  assert.equal(json.validation.status, 'pass');
  assert.equal(json.recipe.path, 'artifacts/recipe-runs/selected/recipe.json');
  assert.match(json.body, /SELECTED_PROOF/);
  assert.match(json.body, /farmslot recipe run task\/recipe.json/);
  assert.doesNotMatch(json.body, /broken stale draft/);
  assert.match(json.body, /Runner: test-runner/);
  assert.doesNotMatch(
    json.body,
    /packages\/cli\/src\/commands\/recipe-artifacts|recipe-runs\/selected/,
  );
  const prosePath = path.join(artifacts, 'pr-description.md');
  const prose = await readFile(prosePath, 'utf8');
  await rm(prosePath);
  const missing = JSON.parse(await invoke(['--format', 'markdown', '--json']));
  assert.equal(process.exitCode, 1);
  assert.match(JSON.stringify(missing), /Missing artifacts\/pr-description/);
  await writeFile(prosePath, prose);
  for (const file of [
    'recipe-runs/selected/recipe.json',
    'pr-description.md',
    'latest-valid-recipe-run.json',
  ]) {
    const out = path.join(artifacts, file);
    const before = await readFile(out, 'utf8');
    const refused = JSON.parse(await invoke(['--format', 'markdown', '--out', out, '--json']));
    assert.equal(process.exitCode, 1);
    assert.match(JSON.stringify(refused), /must not overwrite/);
    assert.equal(await readFile(out, 'utf8'), before);
  }
  assert.equal(
    await readFile(path.join(artifacts, 'latest-valid-recipe-run.json'), 'utf8'),
    pointer,
  );
  const out = path.join(artifacts, 'pr-body.md');
  await writeJson(path.join(selected, 'trace.json'), {
    metadata: { runner: { ...runner, git_ref: 'wrong' } },
    entries: [traceEntry],
  });
  const invalid = JSON.parse(
    await invoke(['--format', 'markdown', '--validate', '--out', out, '--json']),
  );
  assert.match(JSON.stringify(invalid), /Artifact validation failed/);
  await assert.rejects(readFile(out), { code: 'ENOENT' });
});

test('legacy task-root packages allow the usual PR body output while preserving evidence inputs', async (t) => {
  const task = await mkdtemp(path.join(os.tmpdir(), 'legacy-markdown-'));
  const original = await createArtifactPackage({ metadata: { runner }, entries: [traceEntry] });
  t.after(() => rm(task, { recursive: true, force: true }));
  t.after(() => rm(original, { recursive: true, force: true }));
  const artifacts = path.join(task, 'artifacts');
  await rename(original, artifacts);
  await writeFile(path.join(artifacts, 'pr-description.md'), '## Description\n\nAuthored PR.\n');
  await writeFile(
    path.join(artifacts, 'report.md'),
    'Status: pass\nNodes: 1/1 passed\nLEGACY_REPORT\n',
  );
  const invoke = artifactInvocation(t, task);
  const out = path.join(artifacts, 'pr-body.md');
  const rendered = JSON.parse(await invoke(['--format', 'markdown', '--out', out, '--json']));
  assert.equal(process.exitCode, 0, JSON.stringify(rendered));
  assert.equal(rendered.out, out);
  assert.match(await readFile(out, 'utf8'), /Authored PR\./);
  assert.match(await readFile(out, 'utf8'), /LEGACY_REPORT/);
  const summary = path.join(artifacts, 'summary.json');
  const before = await readFile(summary, 'utf8');
  await invoke(['--format', 'markdown', '--out', summary, '--json']);
  assert.equal(process.exitCode, 1);
  assert.equal(await readFile(summary, 'utf8'), before);
});

test('Markdown output preserves consumed comparison closure files', async (t) => {
  const task = await mkdtemp(path.join(os.tmpdir(), 'comparison-output-'));
  const child = await mkdtemp(path.join(os.tmpdir(), 'comparison-source-'));
  t.after(() => rm(task, { recursive: true, force: true }));
  t.after(() => rm(child, { recursive: true, force: true }));
  const engine = createRecipeRunner({
    actionManifest: {
      $schema: 'https://farmslot.io/schemas/action-manifest-v1.schema.json',
      actions: {
        end: { description: 'Finish the recipe', examples: [{ action: 'end', status: 'pass' }] },
      },
    },
    adapters: [],
    runner,
    defaultSource: { kind: 'operator', trust: 'trusted', name: 'artifact-reader-test' },
  });
  assert.equal(
    (await engine.run({ recipeDocument: recipe, artifactsDir: child, projectRoot: task })).status,
    'pass',
  );
  const artifacts = path.join(task, 'artifacts');
  const parent = await engine.run({
    recipeDocument: recipe,
    artifactsDir: artifacts,
    projectRoot: task,
    comparisonDependencies: [child],
    finalizeArtifacts: async (context) => {
      writeRunReport(context);
    },
  });
  assert.equal(parent.status, 'pass');
  await writeFile(
    path.join(artifacts, 'pr-description.md'),
    '## Description\n\nComparison proof.\n',
  );
  const retained = await readRecordedEvidencePackage(artifacts);
  const dependency = retained.input.comparisonDependencies?.[0];
  assert.ok(dependency);
  const relative = `${dependency.artifactRoot}/summary.json`;
  assert.ok(retained.input.artifactPaths?.includes(relative));
  const validated = await validateRecipeArtifactDirectory(artifacts, {
    requireRunnerProvenance: true,
  });
  assert.equal(validated.status, 'pass', JSON.stringify(validated));
  const out = path.join(artifacts, relative);
  const before = await readFile(out, 'utf8');
  const invoke = artifactInvocation(t, task);
  await invoke(['--format', 'markdown', '--out', out, '--json']);
  assert.equal(process.exitCode, 1);
  assert.equal(await readFile(out, 'utf8'), before);
});

test('Markdown output refuses file aliases of authored prose', async (t) => {
  const task = await mkdtemp(path.join(os.tmpdir(), 'alias-output-'));
  t.after(() => rm(task, { recursive: true, force: true }));
  const artifacts = path.join(task, 'artifacts');
  await mkdir(artifacts);
  const prose = path.join(artifacts, 'pr-description.md');
  await writeFile(prose, '## Description\n\nAuthored prose must survive.\n');
  const out = path.join(artifacts, 'body-alias.md');
  await link(prose, out);
  const before = await readFile(prose, 'utf8');
  const invoke = artifactInvocation(t, task);
  await invoke(['--format', 'markdown', '--out', out, '--json']);
  assert.equal(process.exitCode, 1);
  assert.equal(await readFile(prose, 'utf8'), before);
});
