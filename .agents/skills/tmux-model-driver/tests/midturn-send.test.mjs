import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runnerPaneBufferedInstruction } from '../../../../services/gateway/src/runners/runner-pane-input.ts';
import { acknowledgeAcceptance, paneState, send } from '../scripts/driver.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-midturn-'));
  const original = { ...process.env };
  const keys = [];
  const payload = `${'shared prefix '.repeat(20)}exact suffix`;
  let queuedPayload = payload;
  let drop = false;
  let pasted = '';
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
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    assert.equal(command, 'tmux', 'no process, server or native probe is launched');
    keys.push(args);
    if (args[0] === 'load-buffer') pasted = options.input;
    if (args[0] === 'paste-buffer')
      process.env.TMUX_PANE_STATE_TAIL_CAPTURE = `› ${pasted}\n\ncontext left\n`;
    if (args[0] === 'send-keys' && !drop)
      process.env.TMUX_PANE_STATE_TAIL_CAPTURE = `Old transcript: ${payload}\n• Messages to be submitted after\nnext tool call (press esc to interrupt and send\n  immediately)\n  ↳ ${queuedPayload}\n\n› Ask Codex to do anything\ncontext left`;
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
  return {
    dir,
    keys,
    payload,
    setQueuedPayload(value) {
      queuedPayload = value;
    },
    setDrop(value) {
      drop = value;
    },
  };
}

test('unknown Codex delivers the complete owned queue and retries without keystrokes', async (t) => {
  const f = fixture(t);
  const { dir, keys, payload } = f;
  assert.equal(paneState('%1', 'codex').phase, 'unknown');
  const result = await send('%1', 'codex', payload);
  assert.equal(result.verification, 'queued');
  assert.equal(result.submitted, true);
  assert.equal(result.queued, true);
  assert.equal(result.evidence.source, 'runner-queue');
  assert.equal(result.evidence.turn_token, null);
  assert.deepEqual(
    keys.filter((args) => args[0] === 'send-keys'),
    [['send-keys', '-t', '%1', 'Enter']],
  );
  assert.equal(paneState('%1', 'codex').queued, true);
  const before = keys.length;
  const retry = await send('%1', 'codex', payload);
  assert.equal(retry.submitted, true);
  assert.equal(retry.typed, false);
  assert.equal(retry.evidence.receipt_id, result.evidence.receipt_id);
  assert.equal(keys.length, before);
  assert.equal(
    (await send('%1', 'codex', 'foreign queue')).verification,
    'acceptance_unacknowledged',
  );
  assert.equal(keys.length, before);

  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = '›';
  assert.equal((await send('%1', 'codex', payload)).submitted, true);
  assert.equal(
    (await send('%1', 'codex', 'after queue vanished')).verification,
    'acceptance_unacknowledged',
  );
  assert.equal(keys.length, before);
  process.env.TMUX_MODEL_DRIVER_STATE_DIR = path.join(dir, 'foreign');
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE =
    '• Messages to be submitted after\nnext tool call\n↳ foreign payload\n› Ask Codex to do anything';
  assert.equal((await send('%1', 'codex', payload)).verification, 'queued_input');
  assert.equal(keys.length, before, 'wrapped foreign queue is refused without keystrokes');
  process.env.TMUX_MODEL_DRIVER_STATE_DIR = path.join(dir, 'busy');
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = 'tab to queue message\n›';
  const busy = await send('%1', 'codex', payload);
  assert.equal(busy.before.phase, 'busy');
  assert.equal(busy.queued, true);
  assert.equal(busy.submitted, true);

  process.env.TMUX_MODEL_DRIVER_STATE_DIR = path.join(dir, 'mismatch');
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = '›';
  f.setQueuedPayload(`${'shared prefix '.repeat(20)}different suffix`);
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

  process.env.TMUX_MODEL_DRIVER_STATE_DIR = path.join(dir, 'shell');
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = '$';
  process.env.TMUX_MODEL_DRIVER_VERIFY_TIMEOUT_MS = '100';
  const exists = fs.existsSync;
  let shellPolls = 0;
  t.mock.method(fs, 'existsSync', (file) => {
    if (String(file).endsWith('/started')) return ++shellPolls > 1;
    return exists(file);
  });
  const shell = await send('%1', 'shell', 'true');
  assert.equal(shell.submitted, true);
  assert.equal(shell.evidence.source, 'shell-sentinel');
  assert.equal(
    shellPolls,
    2,
    'a delayed shell start polls instead of dereferencing a model receipt',
  );
});

test('a retry submits only the owned composer through Enter while Codex is unknown', async (t) => {
  const f = fixture(t);
  f.setDrop(true);
  const first = await send('%1', 'codex', f.payload);
  assert.equal(first.verification, 'unverified');
  assert.equal(paneState('%1', 'codex').queue_kind, 'driver-buffer');
  f.setDrop(false);
  const retry = await send('%1', 'codex', f.payload);
  assert.equal(retry.submitted, true);
  assert.equal(retry.typed, false);
  assert.equal(f.keys.filter((args) => args[0] === 'paste-buffer').length, 1);
  assert.equal(f.keys.filter((args) => args[0] === 'send-keys').length, 2);
});

test('owned multiline composer retry preserves paragraph breaks and ignores the footer', async (t) => {
  const f = fixture(t);
  const payload = 'First paragraph\n\nSecond paragraph with its exact suffix';
  f.setDrop(true);
  f.setQueuedPayload(payload);
  assert.equal((await send('%1', 'codex', payload)).verification, 'unverified');
  f.setDrop(false);
  const retry = await send('%1', 'codex', payload);
  assert.equal(retry.submitted, true);
  assert.equal(retry.typed, false);
  assert.equal(f.keys.filter((args) => args[0] === 'paste-buffer').length, 1);
});

test('legacy caller receipts share a socket lock and survive read-only observation', async (t) => {
  const f = fixture(t);
  process.env.TMUX = '/tmp/fixture-socket,10,1';
  delete process.env.TMUX_MODEL_DRIVER_SOCKET;
  f.setDrop(true);
  assert.equal((await send('%1', 'codex', f.payload)).verification, 'unverified');
  const current = fs.readdirSync(f.dir).find((name) => /^[a-f0-9]{64}\.json$/.test(name));
  const legacy = createHash('sha256').update(`${process.env.TMUX}:%1:1:1`).digest('hex') + '.json';
  const legacyFile = path.join(f.dir, legacy);
  fs.renameSync(path.join(f.dir, current), legacyFile);
  const original = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  delete original.socket;
  delete original.pane_id;
  delete original.queue_was_empty;
  fs.writeFileSync(legacyFile, JSON.stringify(original));
  process.env.TMUX = '/tmp/fixture-socket,10,2';
  assert.equal(paneState('%1', 'codex').queue_kind, 'driver-buffer');
  const lock = path.join(f.dir, current.replace(/\.json$/, '.lock'));
  fs.mkdirSync(lock);
  assert.equal((await send('%1', 'codex', f.payload)).verification, 'driver_busy');
  fs.rmdirSync(lock);
  f.setDrop(false);
  const result = await send('%1', 'codex', f.payload);
  assert.equal(result.submitted, true);
  assert.equal(result.typed, false);
  assert.equal(result.evidence.receipt_id, original.receipt_id);
  assert.equal(fs.existsSync(legacyFile), true);
  assert.equal(JSON.parse(fs.readFileSync(legacyFile, 'utf8')).queue_was_empty, true);
  const bytes = fs.readFileSync(legacyFile);
  process.env.TMUX_MODEL_DRIVER_READ_ONLY = '1';
  assert.equal(paneState('%1', 'codex').accepted.receipt_id, original.receipt_id);
  assert.deepEqual(fs.readFileSync(legacyFile), bytes);
  delete process.env.TMUX_MODEL_DRIVER_READ_ONLY;
  assert.equal(acknowledgeAcceptance('%1', 'codex', original.receipt_id).acknowledged, true);
  assert.equal(fs.existsSync(legacyFile), false);
});

test('old transcript text, edited composer and a foreign queue cannot authorize a retry', async (t) => {
  const f = fixture(t);
  f.setDrop(true);
  await send('%1', 'codex', f.payload);
  const count = f.keys.length;
  for (const [tail, expected] of [
    [`Old transcript: ${f.payload}\n›`, 'unverified'],
    [`› ${f.payload} edited\n\ncontext left`, 'queued_input'],
    [
      `• Messages to be submitted after next tool call\n↳ foreign\n› ${f.payload}\n\ncontext left`,
      'queued_input',
    ],
  ]) {
    process.env.TMUX_PANE_STATE_TAIL_CAPTURE = tail;
    assert.equal((await send('%1', 'codex', f.payload)).verification, expected);
    assert.equal(f.keys.length, count);
  }
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = `› ${f.payload}\n\ncontext left`;
  process.env.TMUX_PANE_STATE_PROCESS_STARTED_AT = '2';
  assert.equal(paneState('%1', 'codex').accepted, null);
});

for (const [name, phase] of [
  ['composer-idle.txt', 'idle'],
  ['composer-midturn.txt', 'busy'],
]) {
  test(`${phase} reported tail ignores historical prompts and preserves an uncertain receipt during a fresh send`, async (t) => {
    const f = fixture(t);
    const tail = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
    const oldPayload = tail
      .split('\n')
      .find((line) => line.startsWith('› '))
      .slice(2);
    f.setDrop(true);
    assert.equal((await send('%1', 'codex', oldPayload)).verification, 'unverified');
    const file = path.join(
      f.dir,
      fs.readdirSync(f.dir).find((name) => /^[a-f0-9]{64}\.json$/.test(name)),
    );
    const original = fs.readFileSync(file);
    const panes = path.join(f.dir, 'obs', 'panes');
    fs.mkdirSync(panes, { recursive: true });
    fs.writeFileSync(
      path.join(panes, '%251.json'),
      JSON.stringify({
        runner: 'codex',
        tmuxPane: '%1',
        session_id: 'fixture',
        rootSessionId: 'fixture',
        hook_event_name: 'SessionStart',
        observedAt: Date.now(),
        turnActive: phase === 'busy',
      }),
    );
    process.env.TMUX_PANE_STATE_TAIL_CAPTURE = tail;
    assert.equal(runnerPaneBufferedInstruction(tail), '');
    const state = paneState('%1', 'codex');
    assert.equal(state.delivery_phase, phase);
    assert.equal(state.queued, false);
    assert.equal(state.queue_kind, null);
    assert.equal(state.buffered_digest, null);
    const keys = f.keys.length;
    assert.equal((await send('%1', 'codex', oldPayload)).verification, 'unverified');
    assert.equal(f.keys.length, keys, 'the uncertain original is never retyped or submitted');
    const fresh = 'Fresh coordination after the active-composer fix';
    f.setDrop(false);
    f.setQueuedPayload(fresh);
    const delivered = await send('%1', 'codex', fresh);
    assert.equal(delivered.submitted, true);
    assert.equal(delivered.typed, true);
    assert.deepEqual(
      fs.readFileSync(file),
      original,
      'fresh receipt creation preserves old evidence byte for byte',
    );
    assert.equal(f.keys.filter((args) => args[0] === 'paste-buffer').length, 2);
    assert.equal(
      acknowledgeAcceptance('%1', 'codex', delivered.evidence.receipt_id).acknowledged,
      true,
    );
    assert.deepEqual(
      fs.readFileSync(file),
      original,
      'acknowledging the fresh handoff cannot consume the old receipt',
    );
  });
}

test('only current composer text may block or authorize an owned retry', async (t) => {
  const f = fixture(t);
  f.setDrop(true);
  await send('%1', 'codex', f.payload);
  for (const tail of [
    `› ${f.payload}\n\nA historical assistant reply`,
    `› ${f.payload}\n\n› Ask Codex to do anything\n\nGPT-6 high\n? for shortcuts`,
  ]) {
    assert.equal(runnerPaneBufferedInstruction(tail), '');
  }
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = `› foreign current draft\n\ncontext left`;
  const count = f.keys.length;
  assert.equal((await send('%1', 'codex', 'another message')).verification, 'queued_input');
  assert.equal(paneState('%1', 'codex').queue_kind, 'unowned-buffer');
  assert.equal(f.keys.length, count);
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = `› ${f.payload}\n\ncontext left`;
  assert.equal(paneState('%1', 'codex').queue_kind, 'driver-buffer');
});

test('a queued /goal still requires native objective and new-turn evidence', async (t) => {
  const f = fixture(t);
  const payload = '/goal Complete the original objective';
  f.setQueuedPayload(payload);
  const delivered = await send('%1', 'codex', payload);
  assert.equal(delivered.queued, true);
  assert.equal(delivered.submitted, false);
  assert.equal(paneState('%1', 'codex').accepted, null);
});

test('a fresh owned submission accepts the native truncated queue preview', async (t) => {
  const f = fixture(t);
  const lines = Array.from({ length: 20 }, (_, index) => `Admission handoff line ${index}`);
  const payload = lines.join('\n');
  f.setQueuedPayload(lines.slice(0, 3).join('\n') + '\n    …');
  const delivered = await send('%1', 'codex', payload);
  assert.equal(delivered.submitted, true);
  assert.equal(delivered.evidence.source, 'runner-queue');
  const file = path.join(
    f.dir,
    fs.readdirSync(f.dir).find((name) => /^[a-f0-9]{64}\.json$/.test(name)),
  );
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete receipt.queue_was_empty;
  delete receipt.accepted;
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.equal(
    paneState('%1', 'codex').accepted,
    null,
    'old uncertain receipts need complete queue or native proof',
  );
  receipt.queue_was_empty = true;
  fs.writeFileSync(file, JSON.stringify(receipt));
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = `• Messages to be submitted after next tool call\n↳ ${lines[0]}\n    …\n↳ foreign queue\n›`;
  assert.equal(
    paneState('%1', 'codex').accepted,
    null,
    'multiple queued messages cannot use preview ownership',
  );
});
