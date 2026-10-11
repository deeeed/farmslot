import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acceptedCodexGoal,
  acceptedPrompt,
  nativeState,
  writeSentinel,
} from '../scripts/native-evidence.mjs';

test('Codex exact native prompt and new-turn boundary override digest or token ambiguity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-native-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'panes'));
    const native = path.join(dir, 'session.jsonl');
    const now = Date.now(),
      timestamp = new Date(now).toISOString();
    const prompt = `${'same leading text '.repeat(20)}original suffix`;
    const wrongPrompt = `${'same leading text '.repeat(20)}different suffix`;
    const receipt = {
      payload: prompt,
      digest: writeSentinel(dir, prompt, now - 1),
      sent_at: now - 1,
      session_id: 'fixture',
      before_turn_token: 'earlier-turn',
    };
    const hook = {
      runner: 'codex',
      tmuxPane: '%1',
      session_id: 'fixture',
      rootSessionId: 'fixture',
      transcript_path: native,
      hook_event_name: 'UserPromptSubmit',
      observedAt: now,
      turnStartedAt: now,
      turnActive: true,
      runnerPromptDigest: receipt.digest,
    };
    fs.writeFileSync(path.join(dir, 'panes', '%251.json'), JSON.stringify(hook));
    fs.writeFileSync(path.join(dir, 'hooks.jsonl'), `${JSON.stringify(hook)}\n`);
    const meta = { pane_id: '%1', process_started_at: now - 1000 };
    const records = [
      { type: 'session_meta', payload: { id: 'fixture' } },
      { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'new-turn' } },
      {
        type: 'response_item',
        timestamp,
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: wrongPrompt }],
        },
      },
    ];
    const write = () => fs.writeFileSync(native, records.map(JSON.stringify).join('\n') + '\n');
    write();
    assert.equal(acceptedPrompt(meta, 'codex', dir, receipt), null);
    records[2].payload.content[0].text = prompt;
    write();
    assert.equal(acceptedPrompt(meta, 'codex', dir, receipt).turn_token, 'new-turn');
    assert.equal(
      acceptedPrompt(meta, 'codex', dir, { ...receipt, before_turn_token: 'new-turn' }),
      null,
    );
    assert.equal(nativeState(meta, 'codex', dir).phase, 'busy');
    records.push({
      type: 'event_msg',
      timestamp,
      payload: { type: 'task_complete', turn_id: 'new-turn' },
    });
    write();
    assert.equal(nativeState(meta, 'codex', dir).phase, 'idle');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('native goal update plus its new turn proves /goal acceptance without a user-message echo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-goal-test-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    const now = Date.now();
    const receipt = {
      payload: '/goal Finish the proof',
      sent_at: now - 1,
      before_turn_token: 'old',
      payload_hash: 'proof-digest',
    };
    const records = [
      { type: 'session_meta', payload: { id: 'goal-session' } },
      {
        type: 'event_msg',
        timestamp: new Date(now).toISOString(),
        payload: {
          type: 'thread_goal_updated',
          threadId: 'goal-session',
          goal: {
            threadId: 'goal-session',
            objective: 'Finish the proof',
            status: 'active',
          },
        },
      },
      {
        type: 'event_msg',
        timestamp: new Date(now + 1).toISOString(),
        payload: {
          type: 'task_started',
          turn_id: 'new',
        },
      },
    ];
    const write = () => fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
    write();
    assert.equal(acceptedCodexGoal(file, 'goal-session', receipt).turn_token, 'new');
    assert.equal(acceptedCodexGoal(file, 'another-session', receipt), null);
    assert.equal(acceptedCodexGoal(file, 'goal-session', { ...receipt, sent_at: now + 2 }), null);
    records[1].payload.goal.objective = 'A different proof';
    write();
    assert.equal(acceptedCodexGoal(file, 'goal-session', receipt), null);
    records[1].payload.goal.objective = 'Finish the proof';
    records[2].payload.turn_id = 'old';
    write();
    assert.equal(acceptedCodexGoal(file, 'goal-session', receipt), null);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
