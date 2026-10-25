#!/usr/bin/env node
// Exclusive source fixtures before Gateway startup. No UI, cache or native database writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const caseDir = process.env.FARMSLOT_VIEW_SHARING_CASE;
assert(caseDir && path.isAbsolute(caseDir));
const fixture = JSON.parse(await readFile(path.join(caseDir, 'fixture.json'), 'utf8'));
assert.equal(fixture.sourceRoot, root);
const existing = await readdir(path.join(fixture.home, 'gateways.live')).catch((error) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
assert.equal(existing.length, 0, 'Prepare all source files before any Gateway');
const put = (file, value) =>
  writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const marker = path.join(caseDir, 'view-fixture-started.json');
await put(marker, { sourceRoot: root, caseDir });
Object.assign(process.env, {
  FARMSLOT_HOME: fixture.home,
  FARMSLOT_ROOT: fixture.controlRoot,
  FARMSLOT_RUNS_DIR: fixture.runsDir,
  FARMSLOT_POOL_DIR: path.join(fixture.controlRoot, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(fixture.controlRoot, 'projects'),
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
});
const { getRun, updateRun, persistRunNow, loadAllRuns } = await import(
  path.join(root, 'services/gateway/src/runs/store.ts')
);
const { retainCapturedRunArtifacts } = await import(
  path.join(root, 'services/gateway/src/run-completion/retained-artifacts.ts')
);
const digest = (data) => createHash('sha256').update(data).digest('hex');
const before = [];
for (const run of fixture.runs)
  before.push({
    id: run.id,
    sha256: digest(await readFile(path.join(fixture.runsDir, run.id + '.json'))),
  });
const controlProject = 'view-sharing-control';
await mkdir(path.join(fixture.controlRoot, 'projects', controlProject), { mode: 0o700 });
await put(path.join(fixture.controlRoot, 'projects', controlProject, 'project.json'), {
  name: controlProject,
  runtime_dir: '.agent',
  artifact_dir: 'artifacts',
  resources: {},
});
await loadAllRuns();
updateRun(fixture.runs[1].id, { project: controlProject });
await persistRunNow(getRun(fixture.runs[1].id), 'view-sharing control project fixture');
const taskDir = path.join(fixture.controlRoot, 'tasks', fixture.runs[0].id);
await mkdir(path.join(taskDir, 'artifacts'), { recursive: true, mode: 0o700 });
const taskFile = path.join(taskDir, 'task.md');
await writeFile(
  taskFile,
  '# Current-view sharing source fixture\n\nRead-only retained artifacts for navigation proof.\n',
  { flag: 'wx', mode: 0o600 },
);
const files = [
  {
    path: 'artifacts/view-sharing-report.md',
    data: Buffer.from(
      '# View-sharing report\n\nThe displayed document belongs to the retained source run.\n',
    ),
  },
];
const image = new PNG({ width: 160, height: 100 });
for (let y = 0; y < 100; y++)
  for (let x = 0; x < 160; x++) {
    const i = (y * 160 + x) * 4;
    image.data[i] = x < 80 ? 100 : 220;
    image.data[i + 1] = y < 50 ? 140 : 60;
    image.data[i + 2] = 230;
    image.data[i + 3] = 255;
  }
files.push({ path: 'artifacts/view-sharing-image.png', data: PNG.sync.write(image) });
const artifacts = [];
for (const file of files) {
  await writeFile(path.join(taskDir, file.path), file.data, { flag: 'wx', mode: 0o600 });
  artifacts.push({
    path: file.path,
    purpose: 'evidence',
    sha256: digest(file.data),
    sizeBytes: file.data.length,
  });
}
const manifestDigest = digest(JSON.stringify(artifacts));
const now = new Date().toISOString();
const decisions = [
  {
    id: 'view-share-decision-A',
    type: 'plan_confirmation',
    title: 'Sharing decision A',
    description: 'The first source decision.',
    actions: [],
    createdAt: now,
  },
  {
    id: 'view-share-decision-B',
    type: 'plan_confirmation',
    title: 'Sharing decision B',
    description: 'The independent comparison decision.',
    actions: [],
    createdAt: now,
  },
];
updateRun(fixture.runs[0].id, {
  taskFile,
  decisions,
  output: {
    capturedAt: now,
    workerFinished: false,
    artifactManifest: artifacts,
    manifestDigest,
    reportPath: artifacts[0].path,
  },
});
await persistRunNow(getRun(fixture.runs[0].id), 'view-sharing retained source fixture');
await retainCapturedRunArtifacts({
  run: getRun(fixture.runs[0].id),
  artifacts,
  manifestDigest,
  commit: async (ref, missingData) => {
    updateRun(fixture.runs[0].id, {
      artifactBundle: ref,
      output: {
        ...getRun(fixture.runs[0].id).output,
        artifactBundle: ref,
        retentionMissingData: missingData,
      },
    });
    await persistRunNow(getRun(fixture.runs[0].id), 'view-sharing retained bundle fixture');
  },
});
const after = [];
for (const run of fixture.runs) {
  const bytes = await readFile(path.join(fixture.runsDir, run.id + '.json'));
  await writeFile(path.join(caseDir, run.id + '.views-setup.json'), bytes, {
    flag: 'wx',
    mode: 0o600,
  });
  after.push({ id: run.id, sha256: digest(bytes) });
}
await put(path.join(caseDir, 'view-fixture.json'), {
  sourceRoot: root,
  caseDir,
  before,
  after,
  owningWriters: ['updateRun', 'persistRunNow', 'retainCapturedRunArtifacts'],
  controlProject,
  artifacts,
  decisionIds: decisions.map((x) => x.id),
  taskDir,
  taskFile,
});
console.log(
  JSON.stringify({
    status: 'PASS',
    sourceFixturesPrepared: true,
    runId: fixture.runs[0].id,
    artifacts: artifacts.map((x) => x.path),
    decisions: decisions.map((x) => x.id),
    servicesStarted: 0,
    nativeCalls: 0,
  }),
);
