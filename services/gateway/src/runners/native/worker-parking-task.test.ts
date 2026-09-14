import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NATIVE_PARK_TASK_SCRIPT } from './worker-parking-task.js';

test('park task archive survives source removal and refuses damaged or colliding restores', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'native-park-task-'));
  const source = path.join(root, 'source/.task/task');
  const state = path.join(root, 'state');
  const archive = path.join(state, 'parks/command/task');
  const cwd = path.join(root, 'target');
  const destination = path.join(cwd, '.task/task');
  mkdirSync(source, { recursive: true });
  mkdirSync(state);
  mkdirSync(cwd);
  writeFileSync(path.join(source, 'TASK.md'), 'Preserve this exact canonical task');
  writeFileSync(path.join(source, 'CHECKLIST.md'), '- [x] completed work');
  const execute = (params: Record<string, unknown>) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          NATIVE_PARK_TASK_SCRIPT,
          JSON.stringify({ source, state, archive, cwd, destination, ...params }),
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  try {
    const receipt = execute({ operation: 'snapshot' });
    assert.deepEqual(execute({ operation: 'snapshot' }), receipt);
    rmSync(source, { recursive: true });
    execute({ operation: 'restore', ...receipt });
    execute({ operation: 'restore', ...receipt });
    assert.equal(
      readFileSync(path.join(destination, 'CHECKLIST.md'), 'utf8'),
      '- [x] completed work',
    );
    writeFileSync(path.join(destination, 'TASK.md'), 'Another occupant owns this task');
    assert.throws(() => execute({ operation: 'restore', ...receipt }), /different task bundle/);
    assert.equal(
      readFileSync(path.join(destination, 'TASK.md'), 'utf8'),
      'Another occupant owns this task',
    );
    writeFileSync(path.join(archive, 'TASK.md'), 'Archive tampered');
    assert.throws(() => execute({ operation: 'inspect', ...receipt }), /integrity changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('task archive refuses links outside its source bundle', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'native-park-task-links-'));
  const source = path.join(root, 'source');
  const state = path.join(root, 'state');
  const archive = path.join(state, 'task');
  mkdirSync(source);
  mkdirSync(state);
  writeFileSync(path.join(root, 'private'), 'outside task');
  symlinkSync(path.join(root, 'private'), path.join(source, 'linked'));
  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            '-e',
            NATIVE_PARK_TASK_SCRIPT,
            JSON.stringify({ operation: 'snapshot', source, state, archive }),
          ],
          { stdio: 'pipe' },
        ),
      /unsupported file type/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
