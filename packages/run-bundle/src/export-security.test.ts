import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { exportRunsToBundle, listBundle } from './index.js';

function writeMinimalFarmslotRoot(root: string): void {
  writeFileSync(path.join(root, 'CLAUDE.md'), '# farmslot\n', 'utf-8');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'dev.sh'), '#!/bin/bash\n', 'utf-8');
  mkdirSync(path.join(root, 'services', 'gateway'), { recursive: true });
  writeFileSync(path.join(root, 'services', 'gateway', 'package.json'), '{}\n', 'utf-8');
}

function writeRun(root: string, run: Run, taskBody = '# Task'): void {
  const runsDir = path.join(root, '.runs');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(runsDir, `${run.id}.json`), `${JSON.stringify(run, null, 2)}\n`, 'utf-8');
  if (!run.taskFile) return;
  const taskDir = path.dirname(run.taskFile);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(run.taskFile, taskBody, 'utf-8');
}

test('export omits sensitive files from task trees', () => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-export-src-'));
  const bundlePath = path.join(tmpdir(), `export-sec-${Date.now()}.farmrun`);
  const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const taskFile = path.join(
    sourceRoot,
    'projects',
    'demo-farm',
    'tasks',
    'dev',
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
  writeRun(sourceRoot, run);
  writeFileSync(path.join(path.dirname(taskFile), '.env'), 'SECRET=1\n', 'utf-8');

  try {
    exportRunsToBundle({
      farmslotRoot: sourceRoot,
      outputPath: bundlePath,
      profile: 'reference',
      positionalRunId: runId,
    });
    const manifest = listBundle(bundlePath);
    const taskEntries = Object.keys(manifest.entries).filter((key) => key.startsWith('tasks/'));
    assert.ok(taskEntries.some((key) => key.endsWith('/TASK.md')));
    assert.equal(
      taskEntries.some((key) => key.includes('.env')),
      false,
    );
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(bundlePath, { force: true });
  }
});

test('export skips task trees outside farmslot root', () => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-export-src2-'));
  const outsideRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-export-out-'));
  const bundlePath = path.join(tmpdir(), `export-outside-${Date.now()}.farmrun`);
  const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const outsideTask = path.join(
    outsideRoot,
    'projects',
    'demo-farm',
    'tasks',
    'dev',
    'outside',
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
    taskFile: outsideTask,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'claude', runner: 'claude' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeMinimalFarmslotRoot(sourceRoot);
  mkdirSync(path.dirname(outsideTask), { recursive: true });
  writeFileSync(outsideTask, '# outside\n', 'utf-8');
  writeRun(sourceRoot, run, '# outside\n');

  try {
    exportRunsToBundle({
      farmslotRoot: sourceRoot,
      outputPath: bundlePath,
      profile: 'reference',
      positionalRunId: runId,
    });
    const manifest = listBundle(bundlePath);
    assert.equal(manifest.runs[0]?.taskKey, undefined);
    assert.ok(manifest.missingData?.some((item) => item.startsWith('task-path-unapproved:')));
    assert.equal(
      Object.keys(manifest.entries).some((key) => key.startsWith('tasks/')),
      false,
    );
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
    rmSync(bundlePath, { force: true });
  }
});
