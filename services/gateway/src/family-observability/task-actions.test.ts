import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

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
const { materializeInheritedContext } = await import('./context.js');
const { scanArtifacts } = await import('../run-completion/publication-artifacts.js');
const { retainCapturedRunArtifacts, retainedRunTaskDirectory } =
  await import('../run-completion/retained-artifacts.js');
const { copyTaskDirSubdirectories } = await import('../tasks/sidecars.js');

const action = 'fixture.retained_probe';
const files = {
  'task-actions/manifest.json': JSON.stringify({
    $schema: 'https://farmslot.io/schemas/action-manifest-v1.schema.json',
    actions: {
      [action]: {
        description: 'Read the restored fixture.',
        examples: [{ action, intent: 'Verify restored task inputs.', next: 'done' }],
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
  }),
  'task-actions/actions/probe.cjs': 'module.exports = () => ({ restored: true });\n',
  'task-actions/fixtures/input.bin': Buffer.from([0xff, 0, 0x80, 1]),
};

async function fixture(withActions = true) {
  const directory = await mkdtemp(path.join(root, 'parent-'));
  await mkdir(path.join(directory, 'artifacts'), { recursive: true });
  await writeFile(path.join(directory, 'TASK.md'), '# Parent\n');
  await writeFile(
    path.join(directory, 'artifacts/recipe.json'),
    makeRecipeJson({ start: { action, next: 'end' }, end: { action: 'end' } }),
  );
  await mkdir(path.join(directory, 'artifacts/recipe-runs/proof-6'), { recursive: true });
  await writeFile(
    path.join(directory, 'artifacts/recipe-runs/proof-6/summary.json'),
    JSON.stringify({
      recipeRunId: 'proof-1',
      status: 'pass',
      taskActions: [{ action, official: false }],
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
  if (withActions) {
    for (const [relative, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
      await writeFile(path.join(directory, relative), content);
    }
  }
  const parent = makeRun({
    id: path.basename(directory),
    familyId: path.basename(directory),
    flowType: 'dev',
    taskFile: path.join(directory, 'TASK.md'),
  });
  const artifacts = await scanArtifacts(directory);
  await retainCapturedRunArtifacts({
    run: parent,
    artifacts,
    manifestDigest: createHash('sha256').update(JSON.stringify(artifacts)).digest('hex'),
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
  return { parent, child, childTask, retained };
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
  assert.ok(copied.includes('task-actions'));
  for (const [relative, content] of Object.entries(files)) {
    const expected = typeof content === 'string' ? Buffer.from(content) : content;
    assert.deepEqual(await readFile(path.join(f.childTask, relative)), expected);
    assert.deepEqual(await readFile(path.join(workerTask, relative)), expected);
  }
});

test('inheritance refuses a recipe whose recorded task actions were not retained', async () => {
  const f = await fixture(false);
  await assert.rejects(
    materializeInheritedContext(f.child, f.childTask, [f.parent, f.child]),
    /Cannot inherit recipe.*task-actions.*fixture\.retained_probe/,
  );
});

test('inheritance refuses an incomplete retained action implementation', async () => {
  const f = await fixture();
  await rm(path.join(f.retained, 'task-actions/actions/probe.cjs'));
  await assert.rejects(
    materializeInheritedContext(f.child, f.childTask, [f.parent, f.child]),
    /task-actions.*probe\.cjs/,
  );
});
