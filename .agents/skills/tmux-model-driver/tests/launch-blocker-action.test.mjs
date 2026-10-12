import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { paneState, resolveLaunchBlocker } from '../scripts/driver.mjs';

test('pane ownership birth remains stable while the live runner birth changes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-birth-'));
  const original = { ...process.env };
  for (const key of Object.keys(process.env))
    if (key.startsWith('TMUX_PANE_STATE_')) delete process.env[key];
  process.env.TMUX_MODEL_DRIVER_STATE_DIR = dir;
  process.env.TMUX_MODEL_DRIVER_OBSERVABILITY_DIR = path.join(dir, 'obs');
  let live = true;
  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    if (command === 'tmux') {
      if (args.includes('display-message'))
        return '%fixture\tfixture\tzsh\t' + dir + '\t\t42\tfixture';
      if (args.includes('capture-pane')) return '';
    }
    if (command === 'ps') {
      if (args.includes('-p')) return '42 Mon Oct 12 00:00:00 2026';
      return live ? '43 Mon Oct 12 00:00:20 2026 codex login' : '';
    }
    if (command === 'bash') return ''; // No native rollout exists before login.
    throw new Error(`Unexpected probe ${command}`);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    fs.rmSync(dir, { recursive: true });
  });
  const running = paneState('%fixture');
  live = false;
  const shell = paneState('%fixture');
  assert.equal(running.pane_started_at, shell.pane_started_at);
  assert.equal(running.process_started_at - shell.process_started_at, 20_000);
});

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
