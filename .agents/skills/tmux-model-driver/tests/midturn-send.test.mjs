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
  let capturedPaste = null;
  let capturedSubmit = null;
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
      process.env.TMUX_PANE_STATE_TAIL_CAPTURE = capturedPaste ?? `› ${pasted}\n\ncontext left\n`;
    if (args[0] === 'send-keys' && !drop)
      process.env.TMUX_PANE_STATE_TAIL_CAPTURE = capturedSubmit
        ? capturedSubmit(args.at(-1), pasted)
        : `Old transcript: ${payload}\n• Messages to be submitted after\nnext tool call (press esc to interrupt and send\n  immediately)\n  ↳ ${queuedPayload}\n\n› Ask Codex to do anything\ncontext left`;
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
    setCapturedPanes(paste, submit) {
      capturedPaste = paste;
      capturedSubmit = submit;
    },
    setQueuedPayload(value) {
      queuedPayload = value;
    },
    setDrop(value) {
      drop = value;
    },
  };
}

const captured = (name) =>
  fs.readFileSync(new URL(`./fixtures/handoff-${name}.txt`, import.meta.url), 'utf8');

test('the captured rate-limit choice blocks delivery without selecting a model', async (t) => {
  const f = fixture(t);
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = captured('rate-limit-question');
  const result = await send('%1', 'codex', f.payload);
  assert.equal(result.verification, 'pending_question');
  assert.equal(result.submitted, false);
  assert.equal(f.keys.length, 0);
});

test('the captured postponed follow-up is not delivered and never receives Tab', async (t) => {
  const f = fixture(t);
  f.setCapturedPanes(captured('clipped-composer'), () => captured('queued-followup'));
  const result = await send('%1', 'codex', captured('payload'));
  assert.equal(result.submitted, false);
  assert.equal(result.verification, 'not_sent');
  assert.equal(result.evidence, null);
  assert.deepEqual(
    f.keys.filter((args) => args[0] === 'send-keys'),
    [['send-keys', '-t', '%1', 'Enter']],
  );
});

test('a captured composer is never verified merely because its message prefix is visible', async (t) => {
  const f = fixture(t);
  f.setCapturedPanes(captured('clipped-composer'), () => captured('clipped-composer'));
  const result = await send('%1', 'codex', captured('payload'));
  assert.equal(result.submitted, false);
  assert.equal(result.verification, 'unverified');
  assert.equal(result.evidence, null);
  assert.equal(
    fs.readdirSync(f.dir).some((name) => name.endsWith('.json')),
    true,
  );
  assert.equal(f.keys.filter((args) => args[0] === 'paste-buffer').length, 1);
});

test('a working composer left after Enter receives one more Enter and verifies steering', async (t) => {
  const f = fixture(t);
  const message = captured('payload');
  const buffered = `Old transcript: ${message}\n\n› ${message}\n\ncontext left\n  tab to queue message`;
  let submits = 0;
  f.setCapturedPanes(`› ${message}\n\ncontext left`, (key) => {
    assert.equal(key, 'Enter');
    return ++submits === 1
      ? buffered
      : `• Messages to be submitted after next tool call\n  ↳ ${message}\n\n› Ask Codex to do anything\ncontext left`;
  });
  const result = await send('%1', 'codex', message);
  assert.equal(result.submitted, true);
  assert.equal(result.evidence.source, 'runner-steering');
  assert.deepEqual(
    f.keys.filter((args) => args[0] === 'send-keys'),
    [
      ['send-keys', '-t', '%1', 'Enter'],
      ['send-keys', '-t', '%1', 'Enter'],
    ],
  );
  assert.equal(f.keys.filter((args) => args[0] === 'paste-buffer').length, 1);
});

test('an unchanged owned composer stops after two Enters without another paste', async (t) => {
  const f = fixture(t);
  f.setDrop(true);
  const result = await send('%1', 'codex', f.payload);
  assert.equal(result.submitted, false);
  assert.equal(result.verification, 'not_sent');
  assert.equal(result.evidence, null);
  assert.deepEqual(
    f.keys.filter((args) => args[0] === 'send-keys'),
    [
      ['send-keys', '-t', '%1', 'Enter'],
      ['send-keys', '-t', '%1', 'Enter'],
    ],
  );
  assert.equal(f.keys.filter((args) => args[0] === 'paste-buffer').length, 1);
});

test('the captured clipped composer can deliver an Enter steering preview without a native binding', async (t) => {
  const f = fixture(t);
  const steering = captured('queued-followup').replace(
    'Queued follow-up inputs',
    'Messages to be submitted after next tool call',
  );
  f.setCapturedPanes(captured('clipped-composer'), () => steering);
  const result = await send('%1', 'codex', captured('payload'));
  assert.equal(result.submitted, true);
  assert.equal(result.evidence.source, 'runner-steering');
  assert.deepEqual(
    f.keys.filter((args) => args[0] === 'send-keys'),
    [['send-keys', '-t', '%1', 'Enter']],
  );
});

test('a captured foreign follow-up queue refuses a fresh handoff without keystrokes', async (t) => {
  const f = fixture(t);
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = captured('queued-followup');
  const result = await send('%1', 'codex', 'Different fresh handoff');
  assert.equal(result.verification, 'queued_input');
  assert.equal(result.submitted, false);
  assert.equal(f.keys.length, 0);
});

test('unknown Codex delivers the complete owned queue and retries without keystrokes', async (t) => {
  const f = fixture(t);
  const { dir, keys, payload } = f;
  assert.equal(paneState('%1', 'codex').phase, 'unknown');
  const result = await send('%1', 'codex', payload);
  assert.equal(result.verification, 'submitted');
  assert.equal(result.submitted, true);
  assert.equal(result.queued, false);
  assert.equal(result.evidence.source, 'runner-steering');
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
  assert.equal((await send('%1', 'codex', 'foreign queue')).verification, 'queued_input');
  assert.equal(keys.length, before);

  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = '›';
  assert.equal((await send('%1', 'codex', payload)).submitted, true);
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
  assert.equal(busy.queued, false);
  assert.equal(busy.submitted, true);

  process.env.TMUX_MODEL_DRIVER_STATE_DIR = path.join(dir, 'mismatch');
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = '›';
  f.setQueuedPayload(`${'shared prefix '.repeat(20)}different suffix`);
  const mismatch = await send('%1', 'codex', payload);
  assert.equal(mismatch.verification, 'not_sent');
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

test('an exited model receipt remains intact while its shell accepts a guarded recovery script', async (t) => {
  const f = fixture(t);
  f.setDrop(true);
  assert.equal((await send('%1', 'codex', f.payload)).verification, 'not_sent');
  const receipts = fs.readdirSync(f.dir).filter((name) => name.endsWith('.json'));
  const originals = receipts.map((name) => fs.readFileSync(path.join(f.dir, name), 'utf8'));
  process.env.TMUX_PANE_STATE_CURRENT_COMMAND = 'zsh';
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = '$';
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', (file) => String(file).endsWith('/started') || exists(file));
  const shell = await send('%1', 'shell', 'true');
  assert.equal(shell.submitted, true);
  assert.equal(shell.evidence.source, 'shell-sentinel');
  assert.deepEqual(
    receipts.map((name) => fs.readFileSync(path.join(f.dir, name), 'utf8')),
    originals,
  );
  process.env.TMUX_PANE_STATE_CURRENT_COMMAND = 'claude';
  assert.equal(paneState('%1', 'claude').queued, true, 'live model receipt gating is preserved');
});

test('a retry submits only the owned composer through Enter while Codex is unknown', async (t) => {
  const f = fixture(t);
  f.setDrop(true);
  const first = await send('%1', 'codex', f.payload);
  assert.equal(first.verification, 'not_sent');
  assert.equal(paneState('%1', 'codex').queue_kind, 'driver-buffer');
  f.setDrop(false);
  const retry = await send('%1', 'codex', f.payload);
  assert.equal(retry.submitted, true);
  assert.equal(retry.typed, false);
  assert.equal(f.keys.filter((args) => args[0] === 'paste-buffer').length, 1);
  assert.equal(f.keys.filter((args) => args[0] === 'send-keys').length, 3);
});

test('owned multiline composer retry preserves paragraph breaks and ignores the footer', async (t) => {
  const f = fixture(t);
  const payload = 'First paragraph\n\nSecond paragraph with its exact suffix';
  f.setDrop(true);
  f.setQueuedPayload(payload);
  assert.equal((await send('%1', 'codex', payload)).verification, 'not_sent');
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
  assert.equal((await send('%1', 'codex', f.payload)).verification, 'not_sent');
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
    assert.equal((await send('%1', 'codex', oldPayload)).verification, 'not_sent');
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

  test(`${phase} reported footer protects a foreign draft when shortcut and context hints are absent`, async (t) => {
    const f = fixture(t);
    const tail = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
    const draft = 'Foreign current draft';
    process.env.TMUX_PANE_STATE_TAIL_CAPTURE = tail
      .replace('› Ask Codex to do anything', `› ${draft}`)
      .replace('← for agents · ? for shortcuts', phase === 'busy' ? 'tab to queue message' : '');
    assert.equal(runnerPaneBufferedInstruction(process.env.TMUX_PANE_STATE_TAIL_CAPTURE), draft);
    const state = paneState('%1', 'codex');
    assert.equal(state.queued, true);
    assert.equal(state.queue_kind, 'unowned-buffer');
    assert.equal((await send('%1', 'codex', f.payload)).verification, 'queued_input');
    assert.equal(f.keys.length, 0, 'a foreign draft must remain untouched');
    assert.equal(
      fs.readdirSync(f.dir).some((name) => name.endsWith('.json')),
      false,
    );
  });
}

test('a populated composer honours the Context percent left footer', async (t) => {
  const f = fixture(t);
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE =
    '› foreign draft\n\n  GPT-6.1-Sol xhigh · Context 85% left\n  ← for agents';
  assert.equal(
    runnerPaneBufferedInstruction(process.env.TMUX_PANE_STATE_TAIL_CAPTURE),
    'foreign draft',
  );
  assert.equal((await send('%1', 'codex', f.payload)).verification, 'queued_input');
  assert.equal(f.keys.length, 0);
});

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
  assert.equal(delivered.evidence.source, 'runner-steering');
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

test('a retained accepted handoff does not lock another caller out of the same pane', async (t) => {
  const f = fixture(t);
  delete process.env.TMUX_MODEL_DRIVER_SOCKET;
  process.env.TMUX = '/tmp/shared-driver-fixture,10,1';
  const first = await send('%1', 'codex', f.payload);
  assert.equal(first.submitted, true);
  const originalFile = path.join(
    f.dir,
    fs.readdirSync(f.dir).find((name) => /^[a-f0-9]{64}\.json$/.test(name)),
  );
  const originalBytes = fs.readFileSync(originalFile);
  const guardedKeys = f.keys.length;
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = 'Do you want to continue? [y/n]';
  assert.equal(
    (await send('%1', 'codex', 'Second caller handoff')).verification,
    'pending_question',
  );
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = '› Foreign current draft\n\ncontext left';
  assert.equal((await send('%1', 'codex', 'Second caller handoff')).verification, 'queued_input');
  assert.equal(f.keys.length, guardedKeys);
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = '›';
  assert.equal(
    (await send('%1', 'codex', '', undefined, true)).verification,
    'acceptance_unacknowledged',
  );
  process.env.TMUX = '/tmp/shared-driver-fixture,10,2';
  f.setQueuedPayload('Second caller handoff');
  const next = await send('%1', 'codex', 'Second caller handoff');
  assert.equal(next.submitted, true, next.verification);
  assert.equal(next.typed, true);
  assert.notEqual(next.evidence.receipt_id, first.evidence.receipt_id);
  assert.deepEqual(fs.readFileSync(originalFile), originalBytes);
  const keyCount = f.keys.length;
  const retry = await send('%1', 'codex', f.payload);
  assert.equal(retry.submitted, true);
  assert.equal(retry.typed, false);
  assert.equal(retry.evidence.receipt_id, first.evidence.receipt_id);
  assert.equal(f.keys.length, keyCount);
  assert.equal(acknowledgeAcceptance('%1', 'codex', next.evidence.receipt_id).acknowledged, true);
  assert.deepEqual(fs.readFileSync(originalFile), originalBytes);
  assert.equal(acknowledgeAcceptance('%1', 'codex', first.evidence.receipt_id).acknowledged, true);
  assert.equal(fs.existsSync(originalFile), false);
});

test('an old Tab queue receipt cannot claim delivery or authorize another key', async (t) => {
  const f = fixture(t);
  const sent = await send('%1', 'codex', f.payload);
  const file = path.join(
    f.dir,
    fs.readdirSync(f.dir).find((name) => /^[a-f0-9]{64}\.json$/.test(name)),
  );
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  receipt.submit_key = 'Tab';
  receipt.accepted = { ...sent.evidence, source: 'runner-queue' };
  fs.writeFileSync(file, JSON.stringify(receipt));
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = captured('queued-followup');
  assert.equal(paneState('%1', 'codex').accepted, null);
  const before = f.keys.length;
  const retry = await send('%1', 'codex', f.payload);
  assert.equal(retry.submitted, false);
  assert.equal(retry.verification, 'queued_input');
  assert.equal(f.keys.length, before);
  assert.equal(fs.existsSync(file), true);
});

const claudeBox = (text, above = '⏺ Working') =>
  `${above}\n${'─'.repeat(40)}\n❯ ${text}\n${'─'.repeat(40)}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)`;

function claudeFixture(t, status, startedAt = 2, fresh = false) {
  const f = fixture(t);
  const root = path.join(f.dir, 'claude');
  const transcript = path.join(root, 'projects', '-repo', 'claude-session.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.mkdirSync(path.join(root, 'sessions'));
  if (!fresh) fs.writeFileSync(transcript, '');
  fs.writeFileSync(
    path.join(root, 'sessions', '42.json'),
    JSON.stringify({ pid: 42, sessionId: 'claude-session', startedAt, status }),
  );
  Object.assign(process.env, {
    CLAUDE_CONFIG_DIR: root,
    TMUX_PANE_STATE_CURRENT_COMMAND: 'claude',
    TMUX_PANE_STATE_RUNNER_PIDS: '42',
    TMUX_PANE_STATE_TAIL_CAPTURE: claudeBox(''),
  });
  const record = (value) =>
    fs.appendFileSync(
      transcript,
      `${JSON.stringify({ sessionId: 'claude-session', timestamp: new Date().toISOString(), ...value })}\n`,
    );
  return { ...f, record };
}

test('Claude composer parsing reads only the boxed live input', () => {
  assert.equal(runnerPaneBufferedInstruction(claudeBox('')), '');
  assert.equal(runnerPaneBufferedInstruction(claudeBox('Press up to edit queued messages')), '');
  assert.equal(
    runnerPaneBufferedInstruction(claudeBox('first line\n  second line', '❯ old prompt')),
    'first line second line',
  );
  assert.equal(
    runnerPaneBufferedInstruction(claudeBox('draft\n❯ quoted prompt\n\n  ⏵⏵ quoted footer')),
    'draft ❯ quoted prompt ⏵⏵ quoted footer',
  );
  const bashMode = claudeBox('').replace('❯ ', '! ');
  assert.equal(runnerPaneBufferedInstruction(bashMode), '!');
});

test('an idle Claude pane gets one Enter and proves the human prompt in its transcript', async (t) => {
  const f = claudeFixture(t, 'idle');
  f.setCapturedPanes(claudeBox(f.payload), (key, pasted) => {
    f.record({ type: 'user', promptId: 'p1', message: { role: 'user', content: pasted } });
    return claudeBox('');
  });
  const result = await send('%1', 'claude', f.payload);
  assert.equal(result.verification, 'submitted');
  assert.equal(result.evidence.source, 'native-session');
  assert.equal(result.evidence.turn_token, 'p1');
  assert.deepEqual(
    f.keys.filter((args) => args[0] === 'send-keys'),
    [['send-keys', '-t', '%1', 'Enter']],
  );
});

test('a fresh Claude session proves its first prompt once the transcript appears', async (t) => {
  const f = claudeFixture(t, 'idle', 2, true);
  assert.equal(paneState('%1', 'claude').session_id, 'claude-session');
  f.setCapturedPanes(claudeBox(f.payload), (key, pasted) => {
    f.record({ type: 'user', promptId: 'first', message: { role: 'user', content: pasted } });
    return claudeBox('');
  });
  const result = await send('%1', 'claude', f.payload);
  assert.equal(result.submitted, true);
  assert.equal(result.evidence.turn_token, 'first');
});

test('a resumed Claude session reads its live transcript, not an older copy', async (t) => {
  const f = claudeFixture(t, 'idle');
  const stale = path.join(f.dir, 'claude', 'projects', '-0-older', 'claude-session.jsonl');
  fs.mkdirSync(path.dirname(stale));
  fs.writeFileSync(stale, '');
  fs.utimesSync(stale, new Date(0), new Date(0));
  f.setCapturedPanes(claudeBox(f.payload), (key, pasted) => {
    f.record({ type: 'user', promptId: 'live', message: { role: 'user', content: pasted } });
    return claudeBox('');
  });
  const result = await send('%1', 'claude', f.payload);
  assert.equal(result.before.session_path.includes('-0-older'), false);
  assert.equal(result.evidence?.turn_token, 'live');
});

test('a busy Claude turn takes Enter input through its native queue', async (t) => {
  const f = claudeFixture(t, 'busy');
  f.setCapturedPanes(claudeBox(f.payload), (key, pasted) => {
    f.record({ type: 'queue-operation', operation: 'enqueue', content: pasted });
    return claudeBox('Press up to edit queued messages', `❯ ${pasted}`);
  });
  const result = await send('%1', 'claude', f.payload);
  assert.equal(result.before.phase, 'busy');
  assert.equal(result.submitted, true);
  assert.equal(result.evidence.source, 'native-queue');
  assert.equal(paneState('%1', 'claude').queued, false, 'its own queue never blocks a handoff');
  const keys = f.keys.length;
  const retry = await send('%1', 'claude', f.payload);
  assert.equal(
    retry.evidence.receipt_id,
    result.evidence.receipt_id,
    'retained until acknowledged',
  );
  assert.equal(f.keys.length, keys, 'a retry never pastes queued input again');

  f.setCapturedPanes(claudeBox('later'), (key, pasted) => {
    const stale = new Date(Date.now() - 60000).toISOString();
    f.record({
      type: 'attachment',
      timestamp: stale,
      attachment: { type: 'queued_command', prompt: pasted },
    });
    f.record({ type: 'attachment', attachment: { type: 'queued_command', prompt: pasted } });
    return claudeBox('');
  });
  const later = await send('%1', 'claude', 'later');
  assert.equal(later.submitted, true);
  assert.equal(later.evidence.source, 'native-steering');
});

test('a stale Claude record appended after the send never proves it', async (t) => {
  const f = claudeFixture(t, 'busy');
  f.setCapturedPanes(claudeBox(f.payload), (key, pasted) => {
    const stale = new Date(Date.now() - 60000).toISOString();
    f.record({ type: 'queue-operation', operation: 'enqueue', timestamp: stale, content: pasted });
    return claudeBox('');
  });
  const result = await send('%1', 'claude', f.payload);
  assert.equal(result.submitted, false);
  assert.equal(result.evidence, null);
});

test('Claude refuses before typing without its own registered native session', async (t) => {
  const f = claudeFixture(t, 'idle', 0);
  const reused = await send('%1', 'claude', f.payload);
  assert.equal(reused.verification, 'observability_unavailable');
  process.env.TMUX_PANE_STATE_RUNNER_PIDS = '43';
  const missing = await send('%1', 'claude', f.payload);
  assert.equal(missing.verification, 'observability_unavailable');
  assert.equal(f.keys.length, 0);
});

test('a foreign Claude draft refuses delivery without keystrokes', async (t) => {
  const f = claudeFixture(t, 'busy');
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = claudeBox('operator draft');
  const result = await send('%1', 'claude', f.payload);
  assert.equal(result.verification, 'queued_input');
  assert.equal(f.keys.length, 0);
});

test('an older matching Claude prompt never proves a new send', async (t) => {
  const f = claudeFixture(t, 'idle');
  f.record({ type: 'user', promptId: 'old', message: { role: 'user', content: f.payload } });
  f.setDrop(true);
  f.setCapturedPanes(claudeBox(f.payload));
  const result = await send('%1', 'claude', f.payload);
  assert.equal(result.verification, 'not_sent');
  assert.equal(result.evidence, null);
  assert.deepEqual(
    f.keys.filter((args) => args[0] === 'send-keys'),
    [
      ['send-keys', '-t', '%1', 'Enter'],
      ['send-keys', '-t', '%1', 'Enter'],
    ],
  );
});
