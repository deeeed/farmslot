import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { exportRunsToBundle, importBundle, listBundle } from './index.js';

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

test('farmrun export/import round-trip remaps ids in seed mode', () => {
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
    exportRunsToBundle({
      farmslotRoot: sourceRoot,
      outputPath: bundlePath,
      profile: 'reference',
      positionalRunId: runId,
    });
    const manifest = listBundle(bundlePath);
    assert.equal(manifest.runs.length, 1);

    writeMinimalFarmslotRoot(targetRoot);

    const imported = importBundle({
      farmslotRoot: targetRoot,
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

test('farmrun export/import round-trip persists reference-only imports', () => {
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
    exportRunsToBundle({
      farmslotRoot: sourceRoot,
      outputPath: bundlePath,
      profile: 'reference',
      positionalRunId: runId,
    });
    writeMinimalFarmslotRoot(targetRoot);
    const imported = importBundle({
      farmslotRoot: targetRoot,
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

test('farmrun seed import remaps parentRunId redirectedToRunId and familyId', () => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-lineage-src-'));
  const targetRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-lineage-dst-'));
  const bundlePath = path.join(tmpdir(), `bundle-lineage-${Date.now()}.farmrun`);
  const parentId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const childId = 'bbbbbbbb-bbbb-cccc-dddd-ffffffffffffffff';
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
    exportRunsToBundle({
      farmslotRoot: sourceRoot,
      outputPath: bundlePath,
      profile: 'family',
      runIds: [parentId, childId],
    });
    writeMinimalFarmslotRoot(targetRoot);
    const imported = importBundle({
      farmslotRoot: targetRoot,
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
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(bundlePath, { force: true });
  }
});
