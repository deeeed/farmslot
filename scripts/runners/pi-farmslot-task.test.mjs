import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  farmslotStatusLine,
  readFarmslotSignal,
  readTaskMarkdown,
  runFarmslotMark,
  taskDir,
} from './pi-farmslot-task.mjs';

test('farmslotStatusLine includes slot thinking and truncated run id', () => {
  assert.equal(
    farmslotStatusLine({
      FARMSLOT_SLOT_ID: 'macwork-mmedev-2',
      FARMSLOT_RUN_ID: '3b737eb2-c8fd-4119-91c3-9acb0df2c1bd',
      FARMSLOT_THINKING: 'low',
      FARMSLOT_MODEL: 'xai/grok-4.6',
    }),
    'fs macwork-mmedev-2 3b737eb2 low xai/grok-4.6',
  );
});

test('runFarmslotMark executes the task-dir mark shim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mark-'));
  const taskFile = path.join(dir, 'TASK.md');
  fs.writeFileSync(taskFile, '# task\n');
  fs.writeFileSync(path.join(dir, 'mark'), '#!/bin/sh\necho "marked $1"\n', { mode: 0o755 });
  const out = runFarmslotMark('start', { FARMSLOT_TASK_FILE: taskFile });
  assert.match(out, /marked start/);
  assert.equal(taskDir({ FARMSLOT_TASK_FILE: taskFile }), dir);
  assert.equal(readTaskMarkdown({ FARMSLOT_TASK_FILE: taskFile }), '# task\n');
});

test('readFarmslotSignal reports missing then parsed SIGNAL.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-signal-'));
  const taskFile = path.join(dir, 'TASK.md');
  fs.writeFileSync(taskFile, '# task\n');
  const missing = readFarmslotSignal({ FARMSLOT_TASK_FILE: taskFile });
  assert.equal(missing.present, false);
  fs.writeFileSync(path.join(dir, 'SIGNAL.json'), '{"status":"blocked"}\n');
  const present = readFarmslotSignal({ FARMSLOT_TASK_FILE: taskFile });
  assert.equal(present.present, true);
  assert.equal(present.body.status, 'blocked');
});
