import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { paneState, send } from '../scripts/driver.mjs';

test('unknown Codex submits Enter once and verifies the full new queue without a tmux server', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-midturn-'));
  const original = { ...process.env };
  const keys = [];
  const payload = `${'shared prefix '.repeat(20)}exact suffix`;
  let queuedPayload = payload;
  Object.assign(process.env, {
    TMUX_MODEL_DRIVER_STATE_DIR: dir,
    TMUX_MODEL_DRIVER_OBSERVABILITY_DIR: path.join(dir, 'obs'),
    TMUX_MODEL_DRIVER_VERIFY_TIMEOUT_MS: '10',
    TMUX_PANE_STATE_CURRENT_COMMAND: 'codex',
    TMUX_PANE_STATE_CURRENT_PATH: dir,
    TMUX_PANE_STATE_SESSION_NAME: 'fixture',
    TMUX_PANE_STATE_PANE_TITLE: 'fixture',
    TMUX_PANE_STATE_PANE_PID: '1',
    TMUX_PANE_STATE_PROCESS_STARTED_AT: '1',
    TMUX_PANE_STATE_FOREGROUND_COMMANDS: '',
    TMUX_PANE_STATE_TAIL_CAPTURE: '›',
  });
  delete process.env.TMUX_MODEL_DRIVER_READ_ONLY;
  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    assert.equal(command, 'tmux', 'no process, server or native probe is launched');
    keys.push(args);
    if (args[0] === 'send-keys')
      process.env.TMUX_PANE_STATE_TAIL_CAPTURE = `Old transcript: ${payload}\n• Messages to be submitted after next tool call (press esc to interrupt and send\n  immediately)\n  ↳ ${queuedPayload}\n\n› Ask Codex to do anything\ncontext left`;
    return '';
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    fs.rmSync(dir, { recursive: true });
  });
  assert.equal(paneState('%1', 'codex').phase, 'unknown');
  const result = await send('%1', 'codex', payload);
  assert.equal(result.verification, 'submitted');
  assert.equal(result.evidence.source, 'runner-queue');
  assert.equal(result.evidence.turn_token, null);
  assert.deepEqual(
    keys.filter((args) => args[0] === 'send-keys'),
    [['send-keys', '-t', '%1', 'Enter']],
  );
  assert.equal(paneState('%1', 'codex').queued, true);
  const before = keys.length;
  assert.equal((await send('%1', 'codex', 'foreign queue')).verification, 'queued_input');
  assert.equal(keys.length, before);

  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = 'tab to queue message\n›';
  const busy = await send('%1', 'codex', payload);
  assert.equal(busy.before.phase, 'busy');
  assert.equal(busy.submitted, true);

  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = '›';
  queuedPayload = `${'shared prefix '.repeat(20)}different suffix`;
  const mismatch = await send('%1', 'codex', payload);
  assert.equal(mismatch.verification, 'unverified');
  assert.equal(
    mismatch.evidence,
    null,
    'old exact transcript and matching prefix are insufficient',
  );
  const noMoreKeys = keys.length;
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = 'Do you want to continue? [y/n]';
  assert.equal((await send('%1', 'codex', 'answer')).verification, 'pending_question');
  process.env.TMUX_PANE_STATE_CURRENT_COMMAND = 'zsh';
  assert.equal((await send('%1', 'codex', 'shell')).verification, 'wrong_runner');
  assert.equal(keys.length, noMoreKeys);
});
