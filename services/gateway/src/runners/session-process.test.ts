import assert from 'node:assert/strict';
import { execFile as execFileCb, spawn } from 'node:child_process';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { buildFindRunnerDescendantPidCommand } from './session-process.js';

const execFile = promisify(execFileCb);

test('runner descendant scan ignores the diagnostic wrapper after child exit', async () => {
  const wrapper = spawn(
    'bash',
    [
      '-c',
      [
        'false # codex --model gpt-5.5',
        '__farmslot_status=$?',
        'if [ "$__farmslot_status" -ne 0 ]; then',
        '  echo "[farmslot] runner launch command exited $__farmslot_status; preserving pane for diagnostics" >&2',
        '  sleep 30',
        'fi',
      ].join('\n'),
    ],
    { stdio: 'ignore' },
  );

  try {
    await sleep(100);
    const command = buildFindRunnerDescendantPidCommand(String(process.pid), 'codex');
    await assert.rejects(execFile('bash', ['-lc', command]), /Command failed/);
  } finally {
    wrapper.kill('SIGKILL');
  }
});
