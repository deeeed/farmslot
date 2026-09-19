import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CHECKLIST_TARGET_MANIFEST, INTERACTIVE_CHECKLIST_MARKDOWN } from './checklist-target.js';
import {
  CHECKLIST_MARKER_INPUT,
  copyPreparedTaskRootSidecars,
  copyTaskDirSubdirectories,
  isWorkerMirrorEntry,
  TASK_DIR_COPIED_SUBDIRS,
  WORKER_MIRROR_SUFFIX,
} from './sidecars.js';

test('copyPreparedTaskRootSidecars copies CHECKLIST.md beside the marker when present', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-sidecars-'));
  const taskDir = path.join(root, 'task');
  const workerTaskAbs = path.join(root, 'worker');
  await mkdir(taskDir, { recursive: true });
  await mkdir(workerTaskAbs, { recursive: true });
  await writeFile(path.join(taskDir, CHECKLIST_MARKER_INPUT), '#!/usr/bin/env bash\necho mark\n', {
    mode: 0o755,
  });
  await writeFile(
    path.join(taskDir, CHECKLIST_TARGET_MANIFEST),
    `${JSON.stringify({ checklist: 'CHECKLIST.md', signal: 'SIGNAL.json' }, null, 2)}\n`,
    'utf-8',
  );
  await writeFile(path.join(taskDir, INTERACTIVE_CHECKLIST_MARKDOWN), '- [ ] 1. Step\n', 'utf-8');

  const copied = await copyPreparedTaskRootSidecars({
    taskDir,
    workerTaskAbs,
    host: 'localhost',
    machine: 'local',
  });

  assert.deepEqual(copied, [
    CHECKLIST_MARKER_INPUT,
    CHECKLIST_TARGET_MANIFEST,
    INTERACTIVE_CHECKLIST_MARKDOWN,
  ]);
  assert.equal(
    await readFile(path.join(workerTaskAbs, INTERACTIVE_CHECKLIST_MARKDOWN), 'utf-8'),
    '- [ ] 1. Step\n',
  );
});

test('copyPreparedTaskRootSidecars copies executable mark helper locally', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-sidecars-'));
  const taskDir = path.join(root, 'task');
  const workerTaskAbs = path.join(root, 'worker');
  await mkdir(taskDir, { recursive: true });
  await mkdir(workerTaskAbs, { recursive: true });
  await writeFile(path.join(taskDir, CHECKLIST_MARKER_INPUT), '#!/usr/bin/env bash\necho mark\n', {
    mode: 0o755,
  });
  await writeFile(
    path.join(taskDir, CHECKLIST_TARGET_MANIFEST),
    `${JSON.stringify({ checklist: 'TASK.md', signal: 'SIGNAL.json' }, null, 2)}\n`,
    'utf-8',
  );

  const copied = await copyPreparedTaskRootSidecars({
    taskDir,
    workerTaskAbs,
    host: 'localhost',
    machine: 'local',
  });

  assert.deepEqual(copied, [CHECKLIST_MARKER_INPUT, CHECKLIST_TARGET_MANIFEST]);
  const copiedStat = await stat(path.join(workerTaskAbs, CHECKLIST_MARKER_INPUT));
  assert.equal(copiedStat.mode & 0o755, 0o755);
  assert.equal(
    await readFile(path.join(workerTaskAbs, CHECKLIST_TARGET_MANIFEST), 'utf-8'),
    `${JSON.stringify({ checklist: 'TASK.md', signal: 'SIGNAL.json' }, null, 2)}\n`,
  );
});

test('copyPreparedTaskRootSidecars removes a stale role manifest when the fresh task dir has none', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sidecars-stale-manifest-'));
  const taskDir = path.join(root, 'task');
  const workerTaskAbs = path.join(root, 'worker');
  await mkdir(taskDir, { recursive: true });
  await mkdir(workerTaskAbs, { recursive: true });
  await writeFile(path.join(taskDir, CHECKLIST_MARKER_INPUT), '#!/bin/sh\n', 'utf-8');
  // Left behind by an interrupted self-review on the slot: points the mark at
  // the nested checklist. A fresh worker dispatch must not inherit it.
  await writeFile(
    path.join(workerTaskAbs, CHECKLIST_TARGET_MANIFEST),
    JSON.stringify({ checklist: 'SELF-REVIEW.md', signal: 'SELF-REVIEW-SIGNAL.json' }),
    'utf-8',
  );

  const copied = await copyPreparedTaskRootSidecars({
    taskDir,
    workerTaskAbs,
    host: 'localhost',
    machine: 'local',
  });

  assert.deepEqual(copied, [CHECKLIST_MARKER_INPUT]);
  assert.equal(existsSync(path.join(workerTaskAbs, CHECKLIST_TARGET_MANIFEST)), false);
});

test('TASK_DIR_COPIED_SUBDIRS is the one list dispatch, nudge, and warm handoff share', async () => {
  // subtasks/ travels as a directory (ADR-060), not through TASK_ROOT_SIDECARS.
  assert.deepEqual([...TASK_DIR_COPIED_SUBDIRS], ['assets', 'inputs', 'artifacts', 'subtasks']);

  // The three staging paths must read the constant, never their own array: a
  // fourth hand-maintained list is how the copy drifts.
  const gatewaySrc = path.resolve(import.meta.dirname, '..');
  for (const file of [
    'methods/dispatch/execute.ts',
    'methods/dispatch/nudge.ts',
    'methods/dispatch/warm-session-handoff.ts',
  ]) {
    const source = await readFile(path.join(gatewaySrc, file), 'utf-8');
    assert.match(
      source,
      /for \(const subdir of await copyTaskDirSubdirectories\(\{/,
      `${file} must stage subdirectories through the shared copy helper`,
    );
    assert.doesNotMatch(
      source,
      /\['assets', 'inputs', 'artifacts'/,
      `${file} must not keep its own copy list`,
    );
  }
});

test('isWorkerMirrorEntry recognises orchestrator mirror output only', () => {
  assert.equal(isWorkerMirrorEntry(`index.json${WORKER_MIRROR_SUFFIX}`), true);
  assert.equal(isWorkerMirrorEntry('subtasks/perps-review.md.worker'), true);
  assert.equal(isWorkerMirrorEntry('index.json'), false);
  assert.equal(isWorkerMirrorEntry('perps-review-SIGNAL.json'), false);
  // Not a suffix match on the whole path: only the file's own name decides.
  assert.equal(isWorkerMirrorEntry('a.worker/index.json'), false);
});

test('copyTaskDirSubdirectories stages the shared list and never sends mirror output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-subdir-copy-'));
  const taskDir = path.join(root, 'task');
  const workerTaskAbs = path.join(root, 'worker');
  await mkdir(path.join(taskDir, 'subtasks'), { recursive: true });
  await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
  await mkdir(workerTaskAbs, { recursive: true });

  // What `mark sub` wrote, beside what the gateway mirrored back from a previous
  // completion of the same task directory.
  await writeFile(path.join(taskDir, 'subtasks', 'index.json'), '{"schemaVersion":1,"units":[]}\n');
  await writeFile(path.join(taskDir, 'subtasks', 'perps-review.md'), '- [x] **1. review**\n');
  await writeFile(
    path.join(taskDir, 'subtasks', 'perps-review-SIGNAL.json'),
    '{"status":"complete"}\n',
  );
  await writeFile(path.join(taskDir, 'subtasks', 'index.json.worker'), 'stale mirror\n');
  await writeFile(path.join(taskDir, 'subtasks', 'perps-review.md.worker'), 'stale mirror\n');
  await writeFile(path.join(taskDir, 'inputs', 'handoff.json'), '{}\n');
  await writeFile(path.join(taskDir, 'inputs', 'handoff.json.worker'), 'stale mirror\n');

  const copied = await copyTaskDirSubdirectories({
    taskDir,
    workerTaskAbs,
    host: 'localhost',
    machine: 'local',
  });
  // Reported in list order, and only the directories that exist.
  assert.deepEqual(copied, ['inputs', 'subtasks']);

  assert.deepEqual((await readdir(path.join(workerTaskAbs, 'subtasks'))).sort(), [
    'index.json',
    'perps-review-SIGNAL.json',
    'perps-review.md',
  ]);
  assert.deepEqual(await readdir(path.join(workerTaskAbs, 'inputs')), ['handoff.json']);
  // The worker's own files still arrive byte for byte.
  assert.equal(
    await readFile(path.join(workerTaskAbs, 'subtasks', 'perps-review.md'), 'utf-8'),
    '- [x] **1. review**\n',
  );
  // assets/ and artifacts/ were absent at the source, so nothing was created.
  assert.equal(existsSync(path.join(workerTaskAbs, 'artifacts')), false);
});
