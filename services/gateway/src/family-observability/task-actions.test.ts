import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import type { RecipeActionManifestDocument } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

const root = await mkdtemp(path.join(tmpdir(), 'inherited-task-actions-'));
process.env.FARMSLOT_ROOT = path.join(root, 'farm');
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
process.env.PROJECTS_DIR = process.env.FARMSLOT_PROJECTS_DIR;
process.env.FARMSLOT_TEST_STATUS_FILE = path.join(root, 'status.json');
for (const directory of ['farm', 'home', 'runs', 'pool', 'projects'])
  await mkdir(path.join(root, directory), { recursive: true });
for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
  const file = path.join(root, 'farm', marker);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, marker.endsWith('.json') ? '{}' : '');
}
after(() => rm(root, { recursive: true, force: true }));

const { makeRun, makeRecipeJson } = await import('./test-fixtures.js');
const { materializeInheritedContext, buildFollowUpScopeContractSection } =
  await import('./context.js');
const { scanArtifacts } = await import('../run-completion/publication-artifacts.js');
const { retainCapturedRunArtifacts, retainedRunTaskDirectory } =
  await import('../run-completion/retained-artifacts.js');
const { copyTaskDirSubdirectories } = await import('../tasks/sidecars.js');
const { digestRecipeLibrary } = await import('@farmslot/recipe-runner');

const action = 'fixture.retained_probe';
const actionManifest: RecipeActionManifestDocument = {
  $schema: 'https://farmslot.io/schemas/action-manifest-v1.schema.json',
  actions: {
    [action]: {
      description: 'Read the restored fixture.',
      execution_capabilities: ['host-read-export'],
      examples: [{ action, intent: 'Verify restored task inputs.', next: 'done' }],
      schema: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
};
const files = {
  'artifacts/task-actions/manifests/fixture.action-manifest.json': JSON.stringify(actionManifest),
  'artifacts/task-actions/actions/mobile/fixture/retained_probe.mjs':
    'module.exports = () => ({ restored: true });\n',
  'artifacts/task-actions/fixtures/input.bin': Buffer.from([0xff, 0, 0x80, 1]),
};

async function fixture(
  mode: 'complete' | 'missing' | 'partial' | 'legacy' | 'missing-recipe' = 'complete',
  names: readonly string[] = [action],
  recordedDigest?: string,
) {
  const directory = await mkdtemp(path.join(root, 'parent-'));
  await mkdir(path.join(directory, 'artifacts'), { recursive: true });
  await writeFile(path.join(directory, 'artifacts/evidence-manifest.json'), '{}\n');
  await writeFile(path.join(directory, 'TASK.md'), '# Parent\n');
  await writeFile(
    path.join(directory, 'artifacts/recipe.json'),
    makeRecipeJson({ start: { action, next: 'end' }, end: { action: 'end' } }),
  );
  await mkdir(path.join(directory, 'artifacts/recipe-runs/proof-6'), { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await writeFile(path.join(directory, relative), content);
  }
  const digest =
    recordedDigest ?? (await digestRecipeLibrary(path.join(directory, 'artifacts/task-actions')));
  await writeFile(
    path.join(directory, 'artifacts/recipe-runs/proof-6/summary.json'),
    JSON.stringify({
      recipeRunId: 'proof-1',
      status: 'pass',
      taskActions: names.map((action) => ({ action, official: false, digest })),
    }),
  );
  await writeFile(
    path.join(directory, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'proof-1',
      relativeArtifactRoot: 'recipe-runs/proof-6',
      updatedAt: '2026-04-15T00:00:00.000Z',
    }),
  );
  if (mode === 'legacy')
    await rename(
      path.join(directory, 'artifacts/task-actions'),
      path.join(directory, 'task-actions'),
    );
  if (mode === 'missing-recipe') await rm(path.join(directory, 'artifacts/recipe.json'));
  if (mode === 'missing' || mode === 'missing-recipe')
    await rm(path.join(directory, 'artifacts/task-actions'), { recursive: true });
  if (mode === 'partial')
    await rm(
      path.join(directory, 'artifacts/task-actions/actions/mobile/fixture/retained_probe.mjs'),
    );
  const parent = makeRun({
    id: path.basename(directory),
    familyId: path.basename(directory),
    flowType: 'dev',
    taskFile: path.join(directory, 'TASK.md'),
  });
  const artifacts = await scanArtifacts(directory);
  if (mode === 'legacy')
    for (const file of Object.keys(files))
      artifacts.push({ path: file.slice('artifacts/'.length), purpose: 'task-input' });
  const manifestDigest = createHash('sha256').update(JSON.stringify(artifacts)).digest('hex');
  await retainCapturedRunArtifacts({
    run: parent,
    artifacts,
    manifestDigest,
    commit: async (ref) => {
      parent.artifactBundle = ref;
    },
  });
  const retained = await retainedRunTaskDirectory(parent);
  await rm(directory, { recursive: true });
  const child = makeRun({
    id: `child-${parent.id}`,
    familyId: parent.familyId,
    parentRunId: parent.id,
    flowType: 'pr-complete',
  });
  const childTask = path.join(root, child.id);
  return { parent, child, childTask, retained, directory, artifacts, manifestDigest, digest };
}

test('a retained recipe restores its complete task actions after the source task is removed', async () => {
  const f = await fixture();
  const manifest = await materializeInheritedContext(f.child, f.childTask, [f.parent, f.child]);
  assert.equal(
    manifest?.inheritedArtifacts.find((entry) => entry.artifact === 'task-actions')?.sourceRunId,
    f.parent.id,
  );
  const workerTask = path.join(root, `worker-${f.child.id}`);
  const copied = await copyTaskDirSubdirectories({
    taskDir: f.childTask,
    workerTaskAbs: workerTask,
    host: 'localhost',
    machine: 'local',
  });
  assert.ok(copied.includes('artifacts'));
  for (const [relative, content] of Object.entries(files)) {
    const expected = typeof content === 'string' ? Buffer.from(content) : content;
    assert.deepEqual(await readFile(path.join(f.childTask, relative)), expected);
    assert.deepEqual(await readFile(path.join(workerTask, relative)), expected);
  }
});

test('a historical missing action starts with a recorded gap and no inherited proof', async () => {
  const f = await fixture('missing');
  await mkdir(path.join(f.childTask, 'artifacts'), { recursive: true });
  await mkdir(path.join(f.childTask, 'inputs/inherited'), { recursive: true });
  await writeFile(
    path.join(f.childTask, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({ source: 'inherited-family-package', sourceRunId: f.parent.id }),
  );
  await writeFile(path.join(f.childTask, 'inputs/inherited/evidence-manifest.json'), '{}');
  await mkdir(path.join(f.childTask, 'inputs/inherited/task-actions/actions'), { recursive: true });
  await writeFile(
    path.join(f.childTask, 'inputs/inherited/task-actions/actions/stale.mjs'),
    'stale context, not an implementation root',
  );
  const manifest = await materializeInheritedContext(f.child, f.childTask, [f.parent, f.child]);
  assert.ok(manifest);
  assert.deepEqual(manifest.taskActionInputGaps, [
    {
      sourceRunId: f.parent.id,
      canonicalPath: 'artifacts/task-actions',
      libraries: [{ actionNames: [action], expectedLibraryDigest: f.digest }],
      reason: 'not-retained-at-canonical-path',
      requiredAction: 'reauthor-and-revalidate',
      proofReuseEligible: false,
    },
  ]);
  assert.equal(
    manifest.inheritedArtifacts.find((entry) => entry.artifact === 'evidence-package')?.status,
    'missing',
  );
  await assert.rejects(readFile(path.join(f.childTask, 'artifacts/latest-valid-recipe-run.json')), {
    code: 'ENOENT',
  });
  await assert.rejects(
    readFile(path.join(f.childTask, 'inputs/inherited/evidence-manifest.json')),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    readFile(path.join(f.childTask, 'artifacts/task-actions/actions/stale.mjs')),
    { code: 'ENOENT' },
  );
  const instructions = buildFollowUpScopeContractSection(f.childTask, manifest);
  assert.match(instructions, /Re-author/);
  assert.ok(instructions.includes(action));
  assert.ok(instructions.includes(f.digest));
});

test('an action-only edit creates a new capture without rewriting the previous bundle', async () => {
  const f = await fixture();
  const previous = f.parent.artifactBundle;
  assert.ok(previous);
  await writeFile(path.join(root, 'runs', `${f.parent.id}.json`), JSON.stringify(f.parent));
  await cp(f.retained, f.directory, { recursive: true });
  const implementation = path.join(
    f.directory,
    'artifacts/task-actions/actions/mobile/fixture/retained_probe.mjs',
  );
  await chmod(implementation, 0o600);
  const changed = 'module.exports = () => ({ updated: true });\n';
  await writeFile(implementation, changed);
  await retainCapturedRunArtifacts({
    run: f.parent,
    artifacts: f.artifacts,
    manifestDigest: f.manifestDigest,
    commit: async (ref) => {
      f.parent.artifactBundle = ref;
    },
  });
  assert.notEqual(f.parent.artifactBundle?.bundleDigest, previous.bundleDigest);
  const current = await retainedRunTaskDirectory(f.parent);
  assert.equal(
    await readFile(
      path.join(current, 'artifacts/task-actions/actions/mobile/fixture/retained_probe.mjs'),
      'utf8',
    ),
    changed,
  );
  assert.equal(
    await readFile(
      path.join(f.retained, 'artifacts/task-actions/actions/mobile/fixture/retained_probe.mjs'),
      'utf8',
    ),
    files['artifacts/task-actions/actions/mobile/fixture/retained_probe.mjs'],
  );
});

test('inheritance refuses an implementation removed before capture even when its manifest remains', async () => {
  const f = await fixture('partial');
  await assert.rejects(
    materializeInheritedContext(f.child, f.childTask, [f.parent, f.child]),
    /Task-action implementation library digest.*fixture\.retained_probe/,
  );
});

test('inheritance refuses an incomplete retained action implementation', async () => {
  const f = await fixture();
  await rm(
    path.join(f.retained, 'artifacts/task-actions/actions/mobile/fixture/retained_probe.mjs'),
  );
  await assert.rejects(
    materializeInheritedContext(f.child, f.childTask, [f.parent, f.child]),
    /task-actions.*retained_probe\.mjs/,
  );
});

test('root-layout history stays readable but does not become canonical proof', async () => {
  const names = ['metamask.farm.assert_eth_banner', 'metamask.farm.read_order_submit'];
  const f = await fixture(
    'legacy',
    names,
    'sha256:019fe69139448dbb8c94cec215abc492f59ae448af27ed2c07b2cceef5137067',
  );
  const oldFile = 'task-actions/actions/mobile/fixture/retained_probe.mjs';
  const original = await readFile(path.join(f.retained, oldFile));
  const manifest = await materializeInheritedContext(f.child, f.childTask, [f.parent, f.child]);
  assert.ok(manifest);
  assert.deepEqual(manifest.taskActionInputGaps?.[0].libraries, [
    { actionNames: names, expectedLibraryDigest: f.digest },
  ]);
  assert.equal(manifest.taskActionInputGaps?.[0].canonicalPath, 'artifacts/task-actions');
  assert.deepEqual(await readFile(path.join(f.retained, oldFile)), original);
  await assert.rejects(
    readFile(
      path.join(f.childTask, 'artifacts/task-actions/actions/mobile/fixture/retained_probe.mjs'),
    ),
    { code: 'ENOENT' },
  );
  assert.match(
    buildFollowUpScopeContractSection(f.childTask, manifest),
    /Historical files at other locations remain unchanged/,
  );
});

test('a missing multi-action library records seven names against one digest', async () => {
  const names = [
    'attempt_cancel',
    'cancel_by_id',
    'ensure_hip3_order',
    'probe_globals',
    'probe_perps_state',
    'readback_order',
    'venue_order_read',
  ].map((name) => `tat3996.${name}`);
  const f = await fixture(
    'missing',
    names,
    'sha256:2b60133f3ac4e466d466ccd3a668cd40435ac7c2b7e973ffc01bcf9c04238703',
  );
  const manifest = await materializeInheritedContext(f.child, f.childTask, [f.parent, f.child]);
  assert.ok(manifest);
  assert.deepEqual(manifest.taskActionInputGaps?.[0].libraries, [
    { actionNames: names, expectedLibraryDigest: f.digest },
  ]);
  const instructions = buildFollowUpScopeContractSection(f.childTask, manifest);
  assert.equal(instructions.split(f.digest).length - 1, 1);
  for (const name of names) assert.ok(instructions.includes(name));
});

test("missing parent inputs do not erase the child's own selected attempt", async () => {
  const f = await fixture('missing');
  await mkdir(path.join(f.childTask, 'artifacts'), { recursive: true });
  const own = {
    version: 1,
    runId: 'child-proof',
    relativeArtifactRoot: 'recipe-runs/child-proof',
    updatedAt: '2026-11-17T00:00:00Z',
  };
  const pointer = path.join(f.childTask, 'artifacts/latest-valid-recipe-run.json');
  await writeFile(pointer, JSON.stringify(own));
  await materializeInheritedContext(f.child, f.childTask, [f.parent, f.child]);
  assert.deepEqual(JSON.parse(await readFile(pointer, 'utf8')), own);
});

test('recorded action inputs remain explicit when the parent recipe document is missing too', async () => {
  const f = await fixture('missing-recipe', ['task.read_text']);
  const manifest = await materializeInheritedContext(f.child, f.childTask, [f.parent, f.child]);
  assert.ok(manifest);
  assert.equal(
    manifest.inheritedArtifacts.find((entry) => entry.artifact === 'recipe')?.status,
    'missing',
  );
  assert.deepEqual(manifest.taskActionInputGaps?.[0].libraries, [
    { actionNames: ['task.read_text'], expectedLibraryDigest: f.digest },
  ]);
});
