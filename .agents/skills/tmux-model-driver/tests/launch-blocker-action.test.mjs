import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveLaunchBlocker } from '../scripts/driver.mjs';

test('startup skip uses the shared key once, guarded by fresh runner and pane identity', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-action-'));
  const original = process.env.TMUX_MODEL_DRIVER_STATE_DIR;
  process.env.TMUX_MODEL_DRIVER_STATE_DIR = dir;
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    assert.equal(command, 'tmux');
    calls.push(args);
    return '';
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (original === undefined) delete process.env.TMUX_MODEL_DRIVER_STATE_DIR;
    else process.env.TMUX_MODEL_DRIVER_STATE_DIR = original;
    fs.rmSync(dir, { recursive: true });
  });
  const state = {
    state: 'codex',
    auto_action: 'codex-skip-update',
    pane_id: '%fixture',
    pane_pid: 'fixture',
    process_started_at: 1,
    current_path: dir,
    socket_path: 'fixture',
  };
  const result = resolveLaunchBlocker('%fixture', 'codex', () => state);
  assert.equal(result.action_sent, true);
  assert.equal(result.submitted, undefined, 'startup choice does not claim prompt acceptance');
  assert.deepEqual(calls, [['send-keys', '-t', '%fixture', '2', 'Enter']]);
  for (const changed of [
    { ...state, state: 'shell' },
    { ...state, pane_pid: 'replacement' },
    { ...state, auto_action: null },
    { ...state, auto_action: 'auth-required' },
  ]) {
    let reads = 0;
    assert.equal(
      resolveLaunchBlocker('%fixture', 'codex', () => (reads++ ? changed : state)).action_sent,
      false,
    );
  }
  assert.equal(calls.length, 1, 'changed gates and shells receive no keys');
});
