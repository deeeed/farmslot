import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  paneSafety,
  paneState,
  processState,
  refusal,
  validateAnswer,
} from '../scripts/driver.mjs';
import { nativeState, transcriptQuestion, writeSentinel } from '../scripts/native-evidence.mjs';

test('identity comes from process metadata, never rendered runner text', () => {
  for (const runner of ['claude', 'codex', 'cursor', 'gemini', 'grok']) {
    assert.equal(
      processState({
        current_command: runner === 'cursor' ? 'cursor-agent' : runner,
        foreground_commands: [],
      }),
      runner,
    );
  }
  assert.equal(
    processState({ current_command: 'node', foreground_commands: ['node /app/codex.js'] }),
    'codex',
  );
  assert.equal(processState({ current_command: 'zsh', foreground_commands: ['claude'] }), 'claude');
  assert.equal(processState({ current_command: 'node', foreground_commands: [] }), 'unknown');
  assert.equal(processState({ current_command: 'zsh', foreground_commands: [] }), 'shell');
  assert.equal(
    processState({ current_command: 'bash', foreground_commands: ['bash bash -c exec claude'] }),
    'shell',
  );
});

test('question, queue and launch screens only provide fail-closed vetoes', () => {
  assert.equal(paneSafety('Do you want to continue? [y/n]', 'codex').pending_question, true);
  assert.equal(paneSafety('1 queued message', 'codex').queued, true);
  assert.equal(
    paneSafety('The queued input guard prevents duplicate delivery.', 'codex').queued,
    false,
  );
  assert.equal(
    paneSafety('Review queue behavior: queued messages should wait.', 'claude').queued,
    false,
  );
  assert.equal(paneSafety('1 queued message\n1\n2\n3\n4\n5\nready', 'codex').queued, false);
  assert.equal(paneSafety('tab to queue message', 'codex').busy, true);
  assert.equal(
    paneSafety('[a] trust this workspace\n[q] quit\nuse arrow keys to navigate', 'cursor')
      .launch_blocker,
    'workspace-trust',
  );
  assert.equal(paneSafety('[a] trust this workspace\n[q] quit', 'claude').launch_blocker, null);
  assert.equal(paneSafety('Working (fresh)', 'codex').busy, false);
  assert.equal(
    paneSafety('Do you want to continue? [y/n]\n1\n2\n3\n4\n5\n6\nready', 'codex').pending_question,
    false,
  );
});

test('explicit answers permit bounded text and navigation but never Tab or control keys', () => {
  assert.deepEqual(validateAnswer(['Down', 'Enter']), ['Down', 'Enter']);
  assert.deepEqual(validateAnswer([{ text: 'yes' }, 'Enter']), [{ text: 'yes' }, 'Enter']);
  for (const actions of [
    ['Tab'],
    ['C-c'],
    [{ text: 'yes\nno' }],
    [{ text: 'x'.repeat(2049) }],
    [],
  ]) {
    assert.throws(() => validateAnswer(actions));
  }
});

test('send requires the expected runner, idle native state and no question or queue', () => {
  const ready = { state: 'codex', confidence: 'high', delivery_phase: 'idle', phase: 'idle' };
  assert.equal(refusal(ready, 'codex'), null);
  assert.equal(
    refusal({ ...ready, evidence_source: 'native-session-read-only' }, 'codex'),
    'observability_unavailable',
  );
  assert.equal(refusal({ ...ready, state: 'shell' }, 'codex'), 'wrong_runner');
  assert.equal(refusal({ ...ready, state: 'unknown' }, 'codex'), 'wrong_runner');
  assert.equal(refusal({ ...ready, pending_question: true }, 'codex'), 'pending_question');
  assert.equal(refusal({ ...ready, delivery_phase: 'busy' }, 'codex'), 'busy');
  assert.equal(
    refusal({ ...ready, delivery_phase: 'unknown' }, 'codex'),
    'observability_unavailable',
  );
  assert.equal(refusal({ ...ready, queued: true }, 'codex'), 'queued_input');
  assert.equal(
    refusal({ ...ready, queued: true, queue_kind: 'runner-queue' }, 'codex', true),
    'queue_not_owned',
  );
});

test('durable hooks reject a stale reused pane and expose native question details', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-state-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'panes'));
    const transcript = path.join(dir, 'native.jsonl');
    const meta = { pane_id: '%1', process_started_at: Date.now() - 1000 };
    const hook = {
      runner: 'claude',
      tmuxPane: '%1',
      session_id: 'session',
      rootSessionId: 'session',
      transcript_path: transcript,
      hook_event_name: 'SessionStart',
      observedAt: Date.now(),
      turnActive: false,
    };
    fs.writeFileSync(path.join(dir, 'panes', '%251.json'), JSON.stringify(hook));
    assert.equal(nativeState(meta, 'claude', dir).phase, 'idle');
    assert.equal(
      nativeState({ ...meta, process_started_at: Date.now() + 1000 }, 'claude', dir).phase,
      'unknown',
    );
    const tool = {
      type: 'tool_use',
      id: 'q1',
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'Pick a branch?', options: [{ label: 'main' }] }] },
    };
    fs.writeFileSync(transcript, `${JSON.stringify({ message: { content: [tool] } })}\n`);
    assert.equal(transcriptQuestion(transcript).questions[0].question, 'Pick a branch?');
    fs.appendFileSync(
      transcript,
      `${JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'q1' }] } })}\n`,
    );
    assert.equal(transcriptQuestion(transcript), null);
    fs.appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'q2',
          name: 'request_user_input',
          arguments: JSON.stringify({ questions: [{ question: 'Which option?' }] }),
        },
      })}\n`,
    );
    assert.equal(transcriptQuestion(transcript).questions[0].question, 'Which option?');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('read-only inspection reports late acceptance without writing its receipt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-read-test-'));
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      TMUX_MODEL_DRIVER_READ_ONLY: '1',
      TMUX_MODEL_DRIVER_SOCKET: 'read-test',
      TMUX_MODEL_DRIVER_STATE_DIR: path.join(dir, 'state'),
      TMUX_MODEL_DRIVER_OBSERVABILITY_DIR: dir,
      TMUX_PANE_STATE_CURRENT_COMMAND: 'claude',
      TMUX_PANE_STATE_CURRENT_PATH: dir,
      TMUX_PANE_STATE_SESSION_NAME: 'fixture',
      TMUX_PANE_STATE_PANE_TITLE: '',
      TMUX_PANE_STATE_PANE_PID: '1',
      TMUX_PANE_STATE_PROCESS_STARTED_AT: '0',
      TMUX_PANE_STATE_TAIL_CAPTURE: '',
    });
    fs.mkdirSync(path.join(dir, 'state'));
    fs.mkdirSync(path.join(dir, 'panes'));
    const now = Date.now();
    const digest = writeSentinel(dir, 'exact prompt', now - 1);
    const hook = {
      runner: 'claude',
      tmuxPane: '%1',
      session_id: 'fixture',
      rootSessionId: 'fixture',
      hook_event_name: 'UserPromptSubmit',
      observedAt: now,
      turnStartedAt: now,
      turnActive: true,
      runnerPromptDigest: digest,
    };
    fs.writeFileSync(path.join(dir, 'panes', '%251.json'), JSON.stringify(hook));
    fs.writeFileSync(path.join(dir, 'hooks.jsonl'), JSON.stringify(hook) + '\n');
    const key = createHash('sha256').update('read-test:%1:1:0').digest('hex');
    const receipt = {
      payload: 'exact prompt',
      digest,
      payload_hash: createHash('sha256').update('exact prompt').digest('hex'),
      sent_at: now - 1,
      session_id: 'fixture',
      receipt_id: 'late',
    };
    const file = path.join(dir, 'state', key + '.json');
    fs.writeFileSync(file, JSON.stringify(receipt));
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(paneState('%1', 'claude').accepted.receipt_id, 'late');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'state')), [key + '.json']);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true });
  }
});

test('unhooked observation reads the native session held open by the runner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-native-read-test-'));
  const saved = process.env.TMUX_MODEL_DRIVER_READ_ONLY;
  let fd;
  try {
    process.env.TMUX_MODEL_DRIVER_READ_ONLY = '1';
    const file = path.join(dir, 'rollout-fixture.jsonl');
    const records = [
      { type: 'session_meta', payload: { id: 'fixture' } },
      {
        type: 'event_msg',
        timestamp: new Date().toISOString(),
        payload: { type: 'task_complete', turn_id: 'done' },
      },
    ];
    fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
    fd = fs.openSync(file, 'r');
    const meta = { pane_id: '%1', process_started_at: 0, runner_pids: [String(process.pid)] };
    assert.equal(nativeState(meta, 'codex', dir).phase, 'idle');
    assert.equal(nativeState(meta, 'codex', dir).source, 'native-session-read-only');
    delete process.env.TMUX_MODEL_DRIVER_READ_ONLY;
    assert.equal(nativeState(meta, 'codex', dir).phase, 'unknown');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (saved === undefined) delete process.env.TMUX_MODEL_DRIVER_READ_ONLY;
    else process.env.TMUX_MODEL_DRIVER_READ_ONLY = saved;
    fs.rmSync(dir, { recursive: true });
  }
});
