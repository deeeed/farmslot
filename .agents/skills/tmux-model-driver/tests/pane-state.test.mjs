import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { paneSafety, processState, refusal, validateAnswer } from '../scripts/driver.mjs';
import { nativeState, transcriptQuestion } from '../scripts/native-evidence.mjs';

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
