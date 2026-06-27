import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { type Run, RUN_BUNDLE_VERSION, type RunBundleManifest } from '@farmslot/protocol';

import { packFarmrunDirectory } from './archive.js';
import { sha256Text } from './hashing.js';
import { importBundle } from './import.js';

function writeMinimalRoot(root: string): void {
  writeFileSync(path.join(root, 'CLAUDE.md'), '# farmslot\n', 'utf-8');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'dev.sh'), '#!/bin/bash\n', 'utf-8');
  mkdirSync(path.join(root, 'services', 'gateway'), { recursive: true });
  writeFileSync(path.join(root, 'services', 'gateway', 'package.json'), '{}\n', 'utf-8');
}

function buildMaliciousBundle(
  bundleDir: string,
  manifest: RunBundleManifest,
  run: Run,
  runFile: string,
): void {
  const runJson = JSON.stringify(run, null, 2);
  mkdirSync(path.join(bundleDir, 'runs'), { recursive: true });
  writeFileSync(path.join(bundleDir, runFile), runJson, 'utf-8');
  writeFileSync(
    path.join(bundleDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8',
  );
}

test('import rejects manifest path traversal in taskRelativePath', () => {
  const targetRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-sec-dst-'));
  const bundleDir = mkdtempSync(path.join(tmpdir(), 'farmrun-sec-pack-'));
  const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
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
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'claude', runner: 'claude' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const runFile = 'runs/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json';
  const runJson = JSON.stringify(run, null, 2);
  const taskFileRel = 'tasks/task-1/TASK.md';
  const taskContent = '# evil\n';
  const manifest: RunBundleManifest = {
    version: RUN_BUNDLE_VERSION,
    profile: 'reference',
    exportedAt: new Date().toISOString(),
    bundleId: 'bundle-1',
    source: { farmslotRoot: '/tmp/source', runIds: [runId] },
    remapPolicy: 'remap-ids',
    runs: [
      {
        originalRunId: runId,
        runPath: runFile,
        taskKey: 'task-1',
        taskRelativePath: '../../../outside/TASK.md',
      },
    ],
    entries: {
      [runFile]: {
        sha256: sha256Text(runJson),
        bytes: Buffer.byteLength(runJson, 'utf-8'),
        path: runFile,
      },
      [taskFileRel]: {
        sha256: sha256Text(taskContent),
        bytes: Buffer.byteLength(taskContent, 'utf-8'),
        path: taskFileRel,
      },
    },
  };
  buildMaliciousBundle(bundleDir, manifest, run, runFile);
  mkdirSync(path.join(bundleDir, 'tasks', 'task-1'), { recursive: true });
  writeFileSync(path.join(bundleDir, 'tasks', 'task-1', 'TASK.md'), taskContent, 'utf-8');
  const bundlePath = path.join(tmpdir(), `evil-${Date.now()}.farmrun`);
  packFarmrunDirectory(bundleDir, bundlePath);
  writeMinimalRoot(targetRoot);

  try {
    assert.throws(
      () =>
        importBundle({
          farmslotRoot: targetRoot,
          bundlePath,
          mode: 'seed',
        }),
      /Unsafe (bundle relative|task relative) path|Task path escapes/,
    );
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(bundlePath, { force: true });
  }
});

test('import rejects tampered task payload hashes', () => {
  const targetRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-sec-dst3-'));
  const bundleDir = mkdtempSync(path.join(tmpdir(), 'farmrun-sec-pack3-'));
  const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
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
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'claude', runner: 'claude' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const runFile = 'runs/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json';
  const runJson = JSON.stringify(run, null, 2);
  const taskKey = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const taskFileRel = `tasks/${taskKey}/TASK.md`;
  const taskContent = '# task\n';
  const manifest: RunBundleManifest = {
    version: RUN_BUNDLE_VERSION,
    profile: 'reference',
    exportedAt: new Date().toISOString(),
    bundleId: 'bundle-3',
    source: { farmslotRoot: '/tmp/source', runIds: [runId] },
    remapPolicy: 'remap-ids',
    runs: [
      {
        originalRunId: runId,
        runPath: runFile,
        taskKey,
        taskRelativePath: 'projects/demo-farm/tasks/evals/case-1/TASK.md',
      },
    ],
    entries: {
      [runFile]: {
        sha256: sha256Text(runJson),
        bytes: Buffer.byteLength(runJson, 'utf-8'),
        path: runFile,
      },
      [taskFileRel]: {
        sha256: sha256Text(taskContent),
        bytes: Buffer.byteLength(taskContent, 'utf-8'),
        path: taskFileRel,
      },
    },
  };
  buildMaliciousBundle(bundleDir, manifest, run, runFile);
  mkdirSync(path.join(bundleDir, 'tasks', taskKey), { recursive: true });
  writeFileSync(path.join(bundleDir, 'tasks', taskKey, 'TASK.md'), '# tampered\n', 'utf-8');
  const bundlePath = path.join(tmpdir(), `tampered-task-${Date.now()}.farmrun`);
  packFarmrunDirectory(bundleDir, bundlePath);
  writeMinimalRoot(targetRoot);

  try {
    assert.throws(
      () =>
        importBundle({
          farmslotRoot: targetRoot,
          bundlePath,
          mode: 'seed',
        }),
      /Bundle entry byte mismatch: tasks\//,
    );
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(bundlePath, { force: true });
  }
});

test('import rejects manifest entry path aliases for run JSON', () => {
  const targetRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-sec-dst4-'));
  const bundleDir = mkdtempSync(path.join(tmpdir(), 'farmrun-sec-pack4-'));
  const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const evilRun: Run = {
    ...({
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
      taskFile: null,
      steps: [],
      decisions: [],
      metrics: { nudgeCount: 0, model: 'claude', runner: 'claude' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Run),
    ticketOrPr: 'EVIL-OVERRIDE',
  };
  const benignRun: Run = {
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
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'claude', runner: 'claude' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const runFile = 'runs/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json';
  const decoyFile = 'runs/decoy.json';
  const benignJson = JSON.stringify(benignRun, null, 2);
  const evilJson = JSON.stringify(evilRun, null, 2);
  const manifest: RunBundleManifest = {
    version: RUN_BUNDLE_VERSION,
    profile: 'reference',
    exportedAt: new Date().toISOString(),
    bundleId: 'bundle-4',
    source: { farmslotRoot: '/tmp/source', runIds: [runId] },
    remapPolicy: 'remap-ids',
    runs: [{ originalRunId: runId, runPath: runFile }],
    entries: {
      [runFile]: {
        sha256: sha256Text(benignJson),
        bytes: Buffer.byteLength(benignJson, 'utf-8'),
        path: decoyFile,
      },
      [decoyFile]: {
        sha256: sha256Text(benignJson),
        bytes: Buffer.byteLength(benignJson, 'utf-8'),
        path: decoyFile,
      },
    },
  };
  mkdirSync(path.join(bundleDir, 'runs'), { recursive: true });
  writeFileSync(path.join(bundleDir, 'runs', 'decoy.json'), benignJson, 'utf-8');
  writeFileSync(path.join(bundleDir, runFile), evilJson, 'utf-8');
  writeFileSync(path.join(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const bundlePath = path.join(tmpdir(), `alias-${Date.now()}.farmrun`);
  packFarmrunDirectory(bundleDir, bundlePath);
  writeMinimalRoot(targetRoot);

  try {
    assert.throws(
      () =>
        importBundle({
          farmslotRoot: targetRoot,
          bundlePath,
          mode: 'seed',
        }),
      /Bundle entry path alias not allowed/,
    );
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(bundlePath, { force: true });
  }
});

test('import rejects unlisted files under task tree', () => {
  const targetRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-sec-dst5-'));
  const bundleDir = mkdtempSync(path.join(tmpdir(), 'farmrun-sec-pack5-'));
  const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
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
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'claude', runner: 'claude' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const runFile = 'runs/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json';
  const runJson = JSON.stringify(run, null, 2);
  const taskKey = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const taskFileRel = `tasks/${taskKey}/TASK.md`;
  const taskContent = '# task\n';
  const manifest: RunBundleManifest = {
    version: RUN_BUNDLE_VERSION,
    profile: 'reference',
    exportedAt: new Date().toISOString(),
    bundleId: 'bundle-5',
    source: { farmslotRoot: '/tmp/source', runIds: [runId] },
    remapPolicy: 'remap-ids',
    runs: [
      {
        originalRunId: runId,
        runPath: runFile,
        taskKey,
        taskRelativePath: 'projects/demo-farm/tasks/evals/case-1/TASK.md',
      },
    ],
    entries: {
      [runFile]: {
        sha256: sha256Text(runJson),
        bytes: Buffer.byteLength(runJson, 'utf-8'),
        path: runFile,
      },
      [taskFileRel]: {
        sha256: sha256Text(taskContent),
        bytes: Buffer.byteLength(taskContent, 'utf-8'),
        path: taskFileRel,
      },
    },
  };
  buildMaliciousBundle(bundleDir, manifest, run, runFile);
  mkdirSync(path.join(bundleDir, 'tasks', taskKey), { recursive: true });
  writeFileSync(path.join(bundleDir, 'tasks', taskKey, 'TASK.md'), taskContent, 'utf-8');
  writeFileSync(path.join(bundleDir, 'tasks', taskKey, 'evil.sh'), '#!/bin/bash\n', 'utf-8');
  const bundlePath = path.join(tmpdir(), `unlisted-task-${Date.now()}.farmrun`);
  packFarmrunDirectory(bundleDir, bundlePath);
  writeMinimalRoot(targetRoot);

  try {
    assert.throws(
      () =>
        importBundle({
          farmslotRoot: targetRoot,
          bundlePath,
          mode: 'seed',
        }),
      /Bundle contains unlisted file: tasks\//,
    );
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(bundlePath, { force: true });
  }
});

test('import rejects unlisted runPath entries', () => {
  const targetRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-sec-dst2-'));
  const bundleDir = mkdtempSync(path.join(tmpdir(), 'farmrun-sec-pack2-'));
  const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
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
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'claude', runner: 'claude' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const listedRunFile = 'runs/listed.json';
  const listedJson = JSON.stringify(run, null, 2);
  const manifest: RunBundleManifest = {
    version: RUN_BUNDLE_VERSION,
    profile: 'reference',
    exportedAt: new Date().toISOString(),
    bundleId: 'bundle-2',
    source: { farmslotRoot: '/tmp/source', runIds: [runId] },
    remapPolicy: 'remap-ids',
    runs: [{ originalRunId: runId, runPath: 'runs/unlisted.json' }],
    entries: {
      [listedRunFile]: {
        sha256: sha256Text(listedJson),
        bytes: Buffer.byteLength(listedJson, 'utf-8'),
        path: listedRunFile,
      },
    },
  };
  mkdirSync(path.join(bundleDir, 'runs'), { recursive: true });
  writeFileSync(path.join(bundleDir, 'runs', 'listed.json'), listedJson, 'utf-8');
  writeFileSync(path.join(bundleDir, 'runs', 'unlisted.json'), listedJson, 'utf-8');
  writeFileSync(path.join(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const bundlePath = path.join(tmpdir(), `unlisted-${Date.now()}.farmrun`);
  packFarmrunDirectory(bundleDir, bundlePath);
  writeMinimalRoot(targetRoot);

  try {
    assert.throws(
      () =>
        importBundle({
          farmslotRoot: targetRoot,
          bundlePath,
          mode: 'seed',
        }),
      /runPath not listed in manifest entries/,
    );
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(bundlePath, { force: true });
  }
});
