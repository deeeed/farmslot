import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CHECKLIST_TARGET_MANIFEST } from './checklist-target.js';
import { CHECKLIST_MARKER_INPUT, copyPreparedTaskRootSidecars } from './sidecars.js';

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
    `${JSON.stringify({ checklist: 'TASK.md' }, null, 2)}\n`,
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
    `${JSON.stringify({ checklist: 'TASK.md' }, null, 2)}\n`,
  );
});
