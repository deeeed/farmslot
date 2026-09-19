import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CHECKLIST_TARGET_MANIFEST, INTERACTIVE_CHECKLIST_MARKDOWN } from './checklist-target.js';
import {
  CHECKLIST_MARKER_INPUT,
  copyPreparedTaskRootSidecars,
  TASK_DIR_COPIED_SUBDIRS,
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
      /for \(const subdir of TASK_DIR_COPIED_SUBDIRS\)/,
      `${file} must iterate the shared task-dir copy list`,
    );
    assert.doesNotMatch(
      source,
      /\['assets', 'inputs', 'artifacts'/,
      `${file} must not keep its own copy list`,
    );
  }
});
