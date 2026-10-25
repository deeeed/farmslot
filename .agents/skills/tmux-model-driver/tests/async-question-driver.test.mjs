import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { answerQuestion, paneState, send } from '../scripts/driver.mjs';

test('async question identity gates explicit answers while the runner stays busy', async (t) => {
  const originalEnv = { ...process.env };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-async-answer-'));
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(root, { recursive: true });
  });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const keysFile = path.join(root, 'keys');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${keysFile}'\n`, {
    mode: 0o700,
  });
  const now = Date.now();
  const transcript = path.join(root, 'session.jsonl');
  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH}`,
    TMUX_MODEL_DRIVER_SOCKET: 'async-question-fixture',
    TMUX_MODEL_DRIVER_OBSERVABILITY_DIR: root,
    TMUX_MODEL_DRIVER_STATE_DIR: path.join(root, 'state'),
    TMUX_PANE_STATE_CURRENT_COMMAND: 'codex',
    TMUX_PANE_STATE_CURRENT_PATH: root,
    TMUX_PANE_STATE_SESSION_NAME: 'fixture',
    TMUX_PANE_STATE_PANE_TITLE: '',
    TMUX_PANE_STATE_PANE_PID: String(process.pid),
    TMUX_PANE_STATE_PROCESS_STARTED_AT: String(now - 1000),
    TMUX_PANE_STATE_TAIL_CAPTURE:
      '• Queued follow-up inputs\n  ? 1 question\n    ⇧← to answer\n\n› Ask Codex to do anything\n? for shortcuts',
  });
  fs.mkdirSync(path.join(root, 'panes'));
  fs.writeFileSync(
    path.join(root, 'panes', '%251.json'),
    JSON.stringify({
      runner: 'codex',
      tmuxPane: '%1',
      session_id: 'session',
      rootSessionId: 'session',
      transcript_path: transcript,
      observedAt: now,
      hook_event_name: 'SessionStart',
    }),
  );
  const records = [
    { type: 'session_meta', payload: { id: 'session' } },
    {
      type: 'event_msg',
      timestamp: new Date(now).toISOString(),
      payload: { type: 'task_started', turn_id: 'working' },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input_async',
        id: 'fc_question',
        call_id: 'question',
        arguments: JSON.stringify({ questions: [{ title: 'Which URL?' }] }),
      },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'question', output: '{"accepted":true}' },
    },
  ];
  fs.writeFileSync(transcript, records.map(JSON.stringify).join('\n') + '\n');
  const captured = paneState('%1', 'codex');
  assert.equal(captured.pending_question, true);
  assert.equal(captured.queued, true);
  assert.equal(captured.delivery_phase, 'busy');
  assert.equal(captured.question.questions[0].title, 'Which URL?');
  assert.ok(captured.question_fingerprint);
  assert.equal(paneState('%1', 'codex').question_fingerprint, captured.question_fingerprint);
  assert.equal((await send('%1', 'codex', 'unrelated follow-up')).verification, 'pending_question');
  assert.equal(
    (await answerQuestion('%1', 'claude', captured.question_fingerprint, ['Enter'])).verification,
    'wrong_runner',
  );
  assert.equal(
    (await answerQuestion('%1', 'codex', 'stale', ['Enter'])).verification,
    'question_changed',
  );
  assert.equal(fs.existsSync(keysFile), false);
  const actions = ['S-Left', { text: 'https://example.test' }, 'Enter'];
  const answered = await answerQuestion('%1', 'codex', captured.question_fingerprint, actions);
  assert.equal(answered.verification, 'response_sent');
  assert.equal(answered.submitted, false);
  const keys = fs.readFileSync(keysFile, 'utf8');
  assert.match(keys, /send-keys -t %1 S-Left/);
  assert.match(keys, /send-keys -t %1 -l https:\/\/example.test/);
  assert.match(keys, /send-keys -t %1 Enter/);
  fs.writeFileSync(keysFile, '');
  records[2].payload.call_id = 'replacement';
  records[3].payload.call_id = 'replacement';
  fs.writeFileSync(transcript, records.map(JSON.stringify).join('\n') + '\n');
  assert.notEqual(paneState('%1', 'codex').question_fingerprint, captured.question_fingerprint);
  assert.equal(
    (await answerQuestion('%1', 'codex', captured.question_fingerprint, actions)).verification,
    'question_changed',
  );
  assert.equal(fs.readFileSync(keysFile, 'utf8'), '');
});
