import assert from 'node:assert/strict';
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { Run, RunDecision } from '@farmslot/protocol';

import { packFarmrunDirectory, unpackFarmrunArchive } from './archive.js';
import { sha256Text } from './hashing.js';
import { exportRunsToBundle, importBundle, listBundle, parseManifest } from './index.js';
import { fixtureBundleStore, retainFixtureTask } from './retained.test-support.js';

function writeFixtureRun(root: string, run: Run, taskBody = '# Task'): void {
  const runsDir = path.join(root, '.runs');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(runsDir, `${run.id}.json`), `${JSON.stringify(run, null, 2)}\n`, 'utf-8');
  if (!run.taskFile) return;
  const taskDir = path.dirname(run.taskFile);
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  mkdirSync(path.join(taskDir, 'artifacts', 'packages'), { recursive: true });
  writeFileSync(run.taskFile, taskBody, 'utf-8');
  writeFileSync(
    path.join(taskDir, 'artifacts', 'packages', 'reference.result-package.json'),
    JSON.stringify({
      version: 1,
      kind: 'result-package',
      packageId: 'pkg-test',
      packageHash: 'hash',
      status: 'final',
      createdAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      project: run.project,
      familyId: run.familyId,
      objectiveHash: 'obj',
      taskProfile: 'fix-bug',
      source: { kind: 'prior-run', runId: run.id, familyId: run.familyId },
      role: 'reference',
      diff: { source: 'unavailable', available: false },
      axes: {},
      visualEvidence: [],
      validationEvidence: [],
      reviewEvidence: [],
      outcomeClaims: [],
      evidenceRequirements: [],
      missingData: ['rubric-unreviewed'],
    }),
    'utf-8',
  );
}

function writeMinimalFarmslotRoot(root: string): void {
  writeFileSync(path.join(root, 'CLAUDE.md'), '# farmslot\n', 'utf-8');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'dev.sh'), '#!/bin/bash\n', 'utf-8');
  mkdirSync(path.join(root, 'services', 'gateway'), { recursive: true });
  writeFileSync(path.join(root, 'services', 'gateway', 'package.json'), '{}\n', 'utf-8');
}

test('farmrun export/import round-trip remaps ids in seed mode', async () => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-src-'));
  const targetRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-dst-'));
  const bundlePath = path.join(tmpdir(), `bundle-${Date.now()}.farmrun`);
  const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const taskFile = path.join(
    sourceRoot,
    'projects',
    'demo-farm',
    'tasks',
    'evals',
    'case-1',
    'TASK.md',
  );
  const run: Run = {
    id: runId,
    familyId: 'family-1',
    lane: 'comparison',
    variant: 'baseline',
    flowType: 'dev',
    mode: 'validation',
    status: 'done',
    project: 'demo-farm',
    ticketOrPr: 'EVAL-1',
    slotId: 'mac-1',
    branch: 'eval/baseline',
    completionPolicy: 'artifact-only',
    taskFile,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'claude', runner: 'claude' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeMinimalFarmslotRoot(sourceRoot);
  writeFixtureRun(sourceRoot, run);

  try {
    await retainFixtureTask(sourceRoot, run);
    await exportRunsToBundle({
      farmslotRoot: sourceRoot,
      outputPath: bundlePath,
      profile: 'reference',
      positionalRunId: runId,
    });
    const manifest = listBundle(bundlePath);
    assert.equal(manifest.runs.length, 1);

    writeMinimalFarmslotRoot(targetRoot);

    const imported = await importBundle({
      farmslotRoot: targetRoot,
      retentionStore: await fixtureBundleStore(targetRoot),
      bundlePath,
      mode: 'seed',
    });
    assert.equal(imported.importedRunIds.length, 1);
    assert.notEqual(imported.importedRunIds[0], runId);
    const persisted = JSON.parse(
      readFileSync(path.join(targetRoot, '.runs', `${imported.importedRunIds[0]}.json`), 'utf-8'),
    ) as Run;
    assert.equal(persisted.importProvenance?.importedFromRunId, runId);
    assert.equal(persisted.readOnly, false);
    assert.ok(persisted.taskFile?.includes('projects/demo-farm/tasks/evals/case-1/TASK.md'));
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(bundlePath, { force: true });
  }
});

test('farmrun export/import round-trip persists reference-only imports', async () => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-src-'));
  const targetRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-dst-'));
  const bundlePath = path.join(tmpdir(), `bundle-ref-${Date.now()}.farmrun`);
  const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const taskFile = path.join(
    sourceRoot,
    'projects',
    'demo-farm',
    'tasks',
    'evals',
    'case-1',
    'TASK.md',
  );
  const run: Run = {
    id: runId,
    familyId: 'family-1',
    lane: 'comparison',
    variant: 'baseline',
    flowType: 'dev',
    mode: 'validation',
    status: 'done',
    project: 'demo-farm',
    ticketOrPr: 'EVAL-1',
    slotId: 'mac-1',
    branch: 'eval/baseline',
    completionPolicy: 'artifact-only',
    taskFile,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'claude', runner: 'claude' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeMinimalFarmslotRoot(sourceRoot);
  writeFixtureRun(sourceRoot, run);

  try {
    await retainFixtureTask(sourceRoot, run);
    await exportRunsToBundle({
      farmslotRoot: sourceRoot,
      outputPath: bundlePath,
      profile: 'reference',
      positionalRunId: runId,
    });
    writeMinimalFarmslotRoot(targetRoot);
    const imported = await importBundle({
      farmslotRoot: targetRoot,
      retentionStore: await fixtureBundleStore(targetRoot),
      bundlePath,
      mode: 'reference-only',
    });
    assert.equal(imported.importedRunIds.length, 1);
    assert.notEqual(imported.importedRunIds[0], runId);
    assert.match(imported.importedRunIds[0], /^ref-[0-9a-f]{8}-[0-9a-f]{12}$/i);
    const persisted = JSON.parse(
      readFileSync(path.join(targetRoot, '.runs', `${imported.importedRunIds[0]}.json`), 'utf-8'),
    ) as Run;
    assert.equal(persisted.importProvenance?.importedFromRunId, runId);
    assert.equal(persisted.readOnly, true);
    assert.equal(persisted.status, 'done');
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(bundlePath, { force: true });
  }
});

test('farmrun seed import remaps parentRunId redirectedToRunId and familyId', async () => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-lineage-src-'));
  const targetRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-lineage-dst-'));
  const bundlePath = path.join(tmpdir(), `bundle-lineage-${Date.now()}.farmrun`);
  const parentId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const childId = 'bbbbbbbb-bbbb-cccc-dddd-ffffffffffff';
  const familyId = parentId;
  const parentTask = path.join(
    sourceRoot,
    'projects',
    'demo-farm',
    'tasks',
    'dev',
    'parent-case',
    'TASK.md',
  );
  const childTask = path.join(
    sourceRoot,
    'projects',
    'demo-farm',
    'tasks',
    'dev',
    'child-case',
    'TASK.md',
  );
  const parent: Run = {
    id: parentId,
    familyId,
    lane: 'comparison',
    variant: 'baseline',
    flowType: 'dev',
    mode: 'validation',
    status: 'done',
    project: 'demo-farm',
    ticketOrPr: 'PARENT-1',
    slotId: 'mac-1',
    branch: 'eval/baseline',
    completionPolicy: 'artifact-only',
    taskFile: parentTask,
    redirectedToRunId: childId,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'claude', runner: 'claude' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const child: Run = {
    id: childId,
    familyId,
    lane: 'comparison',
    variant: 'candidate',
    flowType: 'dev',
    mode: 'validation',
    status: 'done',
    project: 'demo-farm',
    ticketOrPr: 'CHILD-1',
    slotId: 'mac-1',
    branch: 'eval/candidate',
    completionPolicy: 'artifact-only',
    taskFile: childTask,
    parentRunId: parentId,
    agentContexts: [
      {
        id: 'ctx-child',
        role: 'dev',
        label: 'dev',
        status: 'complete',
        slotId: 'mac-1',
        runId: childId,
        taskFile: childTask,
      },
    ],
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'claude', runner: 'claude' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeMinimalFarmslotRoot(sourceRoot);
  writeFixtureRun(sourceRoot, parent);
  writeFixtureRun(sourceRoot, child);

  try {
    await retainFixtureTask(sourceRoot, parent);
    await retainFixtureTask(sourceRoot, child);
    await exportRunsToBundle({
      farmslotRoot: sourceRoot,
      outputPath: bundlePath,
      profile: 'family',
      runIds: [parentId, childId],
    });
    writeMinimalFarmslotRoot(targetRoot);
    const imported = await importBundle({
      farmslotRoot: targetRoot,
      retentionStore: await fixtureBundleStore(targetRoot),
      bundlePath,
      mode: 'seed',
    });
    assert.equal(imported.importedRunIds.length, 2);
    const newParentId = imported.idMap[parentId];
    const newChildId = imported.idMap[childId];
    assert.ok(newParentId);
    assert.ok(newChildId);
    assert.notEqual(newParentId, parentId);
    assert.notEqual(newChildId, childId);

    const persistedParent = JSON.parse(
      readFileSync(path.join(targetRoot, '.runs', `${newParentId}.json`), 'utf-8'),
    ) as Run;
    const persistedChild = JSON.parse(
      readFileSync(path.join(targetRoot, '.runs', `${newChildId}.json`), 'utf-8'),
    ) as Run;

    assert.equal(persistedParent.familyId, newParentId);
    assert.equal(persistedChild.familyId, newParentId);
    assert.equal(persistedParent.redirectedToRunId, newChildId);
    assert.equal(persistedChild.parentRunId, newParentId);
    assert.equal(persistedChild.agentContexts?.[0]?.runId, newChildId);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(bundlePath, { force: true });
  }
});

interface HistoryFixtureOptions {
  legacy?: boolean;
  torn?: boolean;
  resolved?: boolean;
  task?: boolean;
}

async function historyBundleFixture(
  t: TestContext,
  archived = false,
  options: HistoryFixtureOptions = {},
) {
  const source = mkdtempSync(path.join(tmpdir(), 'history-export-'));
  const target = mkdtempSync(path.join(tmpdir(), 'history-import-'));
  t.after(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const run: Run = {
    id,
    familyId: id,
    lane: 'comparison',
    variant: null,
    flowType: 'dev',
    mode: 'interactive',
    status: 'cancelled',
    project: 'example-history',
    ticketOrPr: 'PROJ-351',
    slotId: null,
    branch: null,
    taskFile: options.task
      ? path.join(source, 'projects/example-history/tasks/dev/history/TASK.md')
      : null,
    steps: [],
    decisions: [],
    decisionHistoryCount: 2,
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-11-03T00:00:00Z',
    updatedAt: '2026-11-03T00:00:00Z',
  };
  const row: RunDecision = {
    id: 'same-id',
    type: 'engine_human_gate',
    title: 'Publish',
    description: 'whole row',
    actions: [],
    createdAt: run.createdAt,
    context: { receiptId: 'untouched' },
  };
  const bytes = JSON.stringify(row) + '\n' + JSON.stringify(row) + '\n';
  if (options.legacy) delete run.decisionHistoryCount;
  if (options.resolved) {
    run.decisions = [
      {
        ...row,
        resolvedAt: '2026-11-03T00:01:00Z',
        resolvedAction: 'hold',
        selectionData: { packageId: 'newer-backup' },
      },
    ];
  }
  writeMinimalFarmslotRoot(source);
  writeMinimalFarmslotRoot(target);
  const sourceDir = path.join(source, '.runs', ...(archived ? ['archive'] : []));
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, `${id}.json`), JSON.stringify(run));
  if (options.task) writeFixtureRun(source, run);
  if (!options.legacy)
    writeFileSync(
      path.join(sourceDir, `${id}.decisions.jsonl`),
      bytes + (options.torn ? '{"id":' : ''),
    );
  if (options.task) await retainFixtureTask(source, run);
  const bundlePath = path.join(source, 'history.farmrun');
  const exported = await exportRunsToBundle({
    farmslotRoot: source,
    outputPath: bundlePath,
    profile: 'reference',
    runIds: [id],
  });
  return { source, target, id, run, row, bytes, bundlePath, exported };
}

for (const archived of [false, true]) {
  test(
    `forced mirror retains decisions changed during materialization in ${archived ? 'an archived' : 'a live'} target`,
    { timeout: 4000 },
    async (t) => {
      const { target, id, run, row, bytes, bundlePath } = await historyBundleFixture(t, false, {
        task: true,
      });
      const directory = path.join(target, '.runs', ...(archived ? ['archive'] : []));
      mkdirSync(directory, { recursive: true });
      const record = path.join(directory, `${id}.json`);
      writeFileSync(record, JSON.stringify({ ...run, decisions: [row] }));
      const retentionStore = await fixtureBundleStore(target);
      const importing = importBundle({
        farmslotRoot: target,
        bundlePath,
        mode: 'mirror',
        force: true,
        retentionStore,
      });
      // Import has yielded inside materialization; neither record commit has run yet.
      const resolved = { ...row, resolvedAt: run.updatedAt, resolvedAction: 'hold' };
      const added = { ...row, id: 'added-during-materialization' };
      writeFileSync(record, JSON.stringify({ ...run, decisions: [resolved, added] }));
      await importing;
      assert.equal(
        readFileSync(path.join(directory, `${id}.decisions.jsonl`), 'utf8'),
        bytes + JSON.stringify(resolved) + '\n' + JSON.stringify(added) + '\n',
      );
      const restored = JSON.parse(readFileSync(record, 'utf8')) as Run;
      assert.deepEqual(restored.decisions, []);
      assert.equal(restored.decisionHistoryCount, 4);
    },
  );
}

test('forced mirror flushes the displaced backup directory before replacement', async (t) => {
  const { target, id, bundlePath } = await historyBundleFixture(t);
  const directory = path.join(target, '.runs');
  mkdirSync(directory, { recursive: true });
  const record = path.join(directory, `${id}.json`);
  writeFileSync(record, '{"id":');
  const directoryStat = fs.statSync(directory);
  let directoryFlushed = false;
  let flushedBeforeReplacement = false;
  const sync = fs.fsyncSync;
  const rename = fs.renameSync;
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    sync(fd);
    const stat = fs.fstatSync(fd);
    if (
      stat.dev === directoryStat.dev &&
      stat.ino === directoryStat.ino &&
      readdirSync(directory).some((name) => name.startsWith(`${id}.json.displaced-`))
    )
      directoryFlushed = true;
  });
  t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (args[1] === record) flushedBeforeReplacement = directoryFlushed;
    rename(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await importBundle({ farmslotRoot: target, bundlePath, mode: 'mirror', force: true });
  assert.equal(flushedBeforeReplacement, true);
});

for (const mode of ['seed', 'reference-only', 'mirror'] as const) {
  for (const archived of [false, true]) {
    test(
      `retired rows round-trip unchanged through ${mode} from ${archived ? 'archive' : 'live'}`,
      { timeout: 4000 },
      async (t) => {
        const { target, id, bytes, bundlePath, exported } = await historyBundleFixture(t, archived);
        assert.ok(exported.manifest.entries[`runs/${id}.decisions.jsonl`]);
        const imported = await importBundle({ farmslotRoot: target, bundlePath, mode });
        const targetId = imported.importedRunIds[0];
        const file = path.join(target, '.runs', `${targetId}.decisions.jsonl`);
        assert.equal(readFileSync(file, 'utf8'), bytes);
        const record = JSON.parse(
          readFileSync(path.join(target, '.runs', `${targetId}.json`), 'utf8'),
        );
        assert.equal(record.decisionHistoryCount, 2);
        if (mode === 'mirror') {
          await importBundle({ farmslotRoot: target, bundlePath, mode, force: true });
          assert.equal(readFileSync(file, 'utf8'), bytes, 'repeated mirror appends no duplicates');
        }
      },
    );
  }
}

for (const scenario of [
  'longer target',
  'divergent history',
  'different active rows',
  'archived target',
  'missing counted journal',
  'legacy bundle',
  'truncated target',
  'truncated archived target',
  'torn target tail',
] as const) {
  test(`forced mirror preserves ${scenario}`, { timeout: 4000 }, async (t) => {
    const { target, id, run, row, bytes, bundlePath, exported } = await historyBundleFixture(
      t,
      false,
      {
        legacy: scenario === 'legacy bundle',
        resolved: scenario === 'different active rows',
      },
    );
    const archived = scenario === 'archived target' || scenario === 'truncated archived target';
    const directory = path.join(target, '.runs', ...(archived ? ['archive'] : []));
    mkdirSync(directory, { recursive: true });
    const journal = path.join(directory, `${id}.decisions.jsonl`);
    const record = path.join(directory, `${id}.json`);
    const targetOnly = { ...row, description: 'target-only', context: { receiptId: 'keep-whole' } };
    const line = JSON.stringify(targetOnly) + '\n';
    const history =
      scenario === 'longer target'
        ? bytes + line
        : scenario === 'divergent history' || archived
          ? line
          : bytes;
    const decisions =
      scenario === 'different active rows'
        ? [row, run.decisions[0], targetOnly, targetOnly]
        : scenario === 'legacy bundle' || archived
          ? [targetOnly]
          : [];
    const truncated = scenario.startsWith('truncated');
    const recordBytes = truncated
      ? '{"id":'
      : JSON.stringify({
          ...run,
          decisions,
          decisionHistoryCount: 99,
        });
    writeFileSync(record, recordBytes);
    if (scenario !== 'missing counted journal')
      writeFileSync(journal, history + (scenario === 'torn target tail' ? '{"id":' : ''));
    if (scenario === 'legacy bundle') {
      assert.equal(exported.manifest.entries[`runs/${id}.decisions.jsonl`], undefined);
      assert.equal(run.decisionHistoryCount, undefined);
    }
    await importBundle({ farmslotRoot: target, bundlePath, mode: 'mirror', force: true });
    const expected =
      scenario === 'divergent history'
        ? line + bytes
        : archived
          ? line + bytes + (truncated ? '' : line)
          : scenario === 'different active rows'
            ? bytes + JSON.stringify(row) + '\n' + line + line
            : scenario === 'legacy bundle' || scenario === 'longer target'
              ? bytes + line
              : bytes;
    const actual = readFileSync(journal, 'utf8');
    // A target-only torn tail can remain when the merge has nothing to append.
    assert.equal(actual.slice(0, actual.lastIndexOf('\n') + 1), expected);
    const restored = JSON.parse(readFileSync(record, 'utf8'));
    assert.deepEqual(restored.decisions, run.decisions);
    assert.equal(restored.decisionHistoryCount, expected.split('\n').length - 1);
    assert.equal(existsSync(path.join(target, '.runs', `${id}.json`)), !archived);
    const displacedFiles = readdirSync(directory).filter((name) =>
      name.startsWith(`${id}.json.displaced-`),
    );
    assert.equal(displacedFiles.length, truncated ? 1 : 0);
    if (truncated)
      assert.equal(readFileSync(path.join(directory, displacedFiles[0]), 'utf8'), recordBytes);
  });
}

for (const archived of [false, true]) {
  test(
    `torn ${archived ? 'archived' : 'live'} source exports complete rows without changing source`,
    { timeout: 4000 },
    async (t) => {
      const { source, target, id, bytes, bundlePath, exported } = await historyBundleFixture(
        t,
        archived,
        { torn: true },
      );
      const journal = path.join(
        source,
        '.runs',
        ...(archived ? ['archive'] : []),
        `${id}.decisions.jsonl`,
      );
      const original = Buffer.from(bytes + '{"id":');
      assert.deepEqual(readFileSync(journal), original);
      assert.equal(
        exported.manifest.entries[`runs/${id}.decisions.jsonl`].bytes,
        Buffer.byteLength(bytes),
      );
      await importBundle({ farmslotRoot: target, bundlePath, mode: 'mirror' });
      assert.equal(
        readFileSync(path.join(target, '.runs', `${id}.decisions.jsonl`), 'utf8'),
        bytes,
      );
      assert.equal(
        JSON.parse(readFileSync(path.join(target, '.runs', `${id}.json`), 'utf8'))
          .decisionHistoryCount,
        2,
      );
      assert.deepEqual(readFileSync(journal), original);
    },
  );
}

for (const mode of ['seed', 'reference-only', 'mirror'] as const) {
  test(
    `an older bundle with a torn journal imports complete rows through ${mode}`,
    { timeout: 4000 },
    async (t) => {
      const { target, id, bytes, bundlePath } = await historyBundleFixture(t);
      const directory = unpackFarmrunArchive(bundlePath);
      t.after(() => rmSync(path.dirname(directory), { recursive: true, force: true }));
      const historyPath = `runs/${id}.decisions.jsonl`;
      const torn = bytes + '{"id":';
      writeFileSync(path.join(directory, historyPath), torn);
      const manifest = parseManifest(directory);
      manifest.entries[historyPath] = {
        path: historyPath,
        sha256: sha256Text(torn),
        bytes: Buffer.byteLength(torn),
      };
      writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
      const olderBundle = path.join(target, 'older-torn.farmrun');
      packFarmrunDirectory(directory, olderBundle);
      const imported = await importBundle({ farmslotRoot: target, bundlePath: olderBundle, mode });
      const targetId = imported.importedRunIds[0];
      assert.equal(
        readFileSync(path.join(target, '.runs', `${targetId}.decisions.jsonl`), 'utf8'),
        bytes,
      );
      assert.equal(
        JSON.parse(readFileSync(path.join(target, '.runs', `${targetId}.json`), 'utf8'))
          .decisionHistoryCount,
        2,
      );
      assert.equal(readFileSync(path.join(directory, historyPath), 'utf8'), torn);
    },
  );
}

test(
  'retained artifact captures round-trip complete rows without changing a torn source',
  { timeout: 4000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'history-capture-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeMinimalFarmslotRoot(root);
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const run: Run = {
      id,
      familyId: id,
      lane: 'comparison',
      variant: null,
      flowType: 'dev',
      mode: 'interactive',
      status: 'cancelled',
      project: 'example-history',
      ticketOrPr: 'PROJ-351',
      slotId: null,
      branch: null,
      taskFile: path.join(root, 'projects/example-history/tasks/dev/history/TASK.md'),
      steps: [],
      decisions: [],
      decisionHistoryCount: 1,
      metrics: { nudgeCount: 0, model: null, runner: null },
      createdAt: '2026-11-03T00:00:00Z',
      updatedAt: '2026-11-03T00:00:00Z',
    };
    writeFixtureRun(root, run);
    const bytes =
      JSON.stringify({
        id: 'retired',
        type: 'engine_human_gate',
        title: 'Publish',
        description: 'whole',
        actions: [],
        createdAt: run.createdAt,
      }) + '\n';
    const journal = path.join(root, '.runs', `${id}.decisions.jsonl`);
    const original = Buffer.concat([Buffer.from(bytes), Buffer.from([123, 34, 0xe2, 0x82])]);
    writeFileSync(journal, original);
    await retainFixtureTask(root, run);
    assert.ok(run.artifactBundle);
    const store = await fixtureBundleStore(root);
    const { readRetainedRunBundle } = await import('./index.js');
    const retained = await readRetainedRunBundle(store, run.artifactBundle, run.id);
    assert.ok(retained.manifest.entries[`runs/${id}.decisions.jsonl`]);
    assert.equal(
      readFileSync(path.join(retained.directory, `runs/${id}.decisions.jsonl`), 'utf8'),
      bytes,
    );
    assert.deepEqual(readFileSync(journal), original);
    const target = path.join(root, 'restored');
    mkdirSync(target);
    writeMinimalFarmslotRoot(target);
    const capturedBundle = path.join(root, 'captured.farmrun');
    packFarmrunDirectory(retained.directory, capturedBundle);
    await importBundle({
      farmslotRoot: target,
      bundlePath: capturedBundle,
      mode: 'mirror',
      retentionStore: await fixtureBundleStore(target),
    });
    assert.equal(readFileSync(path.join(target, '.runs', `${id}.decisions.jsonl`), 'utf8'), bytes);
    assert.equal(
      JSON.parse(readFileSync(path.join(target, '.runs', `${id}.json`), 'utf8'))
        .decisionHistoryCount,
      1,
    );
    assert.deepEqual(readFileSync(journal), original);
  },
);
