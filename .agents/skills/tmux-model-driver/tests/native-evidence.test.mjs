import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acceptedCodexGoal,
  acceptedPrompt,
  nativeState,
  paneIdentity,
  readOptional,
  transcriptQuestion,
  writeSentinel,
} from '../scripts/native-evidence.mjs';

// A sparse file passes the largest string a process can hold without writing those bytes.
function oversizedLog(t, head, tail) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-oversized-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, 'native.jsonl');
  fs.writeFileSync(file, head.map((record) => `${JSON.stringify(record)}\n`).join(''));
  fs.truncateSync(file, 600 * 1024 * 1024);
  const offset = fs.statSync(file).size;
  fs.appendFileSync(file, `\n${tail.map(JSON.stringify).join('\n')}\n`);
  return { file, offset };
}

test('native logs past the largest string are read in bounded ranges', (t) => {
  const question = {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'request_user_input',
      call_id: 'q1',
      arguments: JSON.stringify({ questions: [{ question: 'Ship it?' }] }),
    },
  };
  const { file } = oversizedLog(t, [{ type: 'session_meta', payload: { id: 's' } }], [question]);
  assert.equal(transcriptQuestion(file).questions[0].question, 'Ship it?');
  assert.throws(
    () => readOptional(file),
    /needs a \d+-byte read; native logs are read in bounded ranges/,
  );
});

test('/goal proof reads the session header and only records after the send', (t) => {
  const now = Date.now();
  const { file, offset } = oversizedLog(
    t,
    [{ type: 'session_meta', payload: { id: 'goal-session' } }],
    [
      {
        type: 'event_msg',
        timestamp: new Date(now).toISOString(),
        payload: {
          type: 'thread_goal_updated',
          threadId: 'goal-session',
          goal: { threadId: 'goal-session', objective: 'Finish', status: 'active' },
        },
      },
      {
        type: 'event_msg',
        timestamp: new Date(now + 1).toISOString(),
        payload: { type: 'task_started', turn_id: 'new' },
      },
    ],
  );
  const receipt = { payload: '/goal Finish', sent_at: now - 1, before_turn_token: 'old' };
  assert.equal(
    acceptedCodexGoal(file, 'goal-session', { ...receipt, session_offset: offset }).turn_token,
    'new',
  );
  assert.equal(acceptedCodexGoal(file, 'goal-session', receipt).turn_token, 'new');
});

test('a pending unknown-session receipt binds only through exact native acceptance on its pane process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-late-binding-'));
  const file = path.join(dir, 'rollout-late-binding.jsonl');
  const now = Date.now();
  const payload = 'unique late steering';
  const meta = {
    pane_id: '%1',
    pane_pid: '1',
    process_started_at: 1,
    runner_pids: [String(process.pid)],
  };
  const receipt = {
    payload,
    session_id: null,
    steering: true,
    submitted_at: now,
    sent_at: now,
    pane_identity: paneIdentity(meta),
    before_turn_token: null,
  };
  const records = [
    { type: 'session_meta', payload: { id: 'late-session', source: 'cli' } },
    {
      type: 'event_msg',
      timestamp: new Date(now - 1).toISOString(),
      payload: { type: 'task_started', turn_id: 'active' },
    },
    {
      type: 'response_item',
      timestamp: new Date(now + 1).toISOString(),
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: payload }] },
    },
  ];
  fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
  const fd = fs.openSync(file, 'r');
  const child = path.join(dir, 'rollout-subagent.jsonl');
  fs.writeFileSync(
    child,
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'child',
        source: { subagent: { thread_spawn: { parent_thread_id: 'late-session' } } },
      },
    }) + '\n',
  );
  const childFd = fs.openSync(child, 'r');
  try {
    assert.equal(acceptedPrompt(meta, 'codex', dir, receipt).session_id, 'late-session');
    assert.equal(acceptedPrompt({ ...meta, process_started_at: 2 }, 'codex', dir, receipt), null);
    const other = path.join(dir, 'rollout-other-parent.jsonl');
    fs.writeFileSync(
      other,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'other-parent',
          source: 'cli',
        },
      }) + '\n',
    );
    const otherFd = fs.openSync(other, 'r');
    try {
      assert.equal(
        acceptedPrompt(meta, 'codex', dir, receipt),
        null,
        'two root sessions remain ambiguous',
      );
    } finally {
      fs.closeSync(otherFd);
    }
  } finally {
    fs.closeSync(fd);
    fs.closeSync(childFd);
    fs.rmSync(dir, { recursive: true });
  }
});

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
    assert.equal(
      acceptedPrompt(meta, 'codex', dir, {
        ...receipt,
        before_turn_token: 'new-turn',
        steering: true,
      }).source,
      'native-steering',
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

test('native parent interruption clears inherited active state without treating child stops as parent stops', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interrupted-parent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'panes'));
  const session = 'interrupted-parent';
  const file = path.join(dir, session + '.jsonl');
  const now = Date.now();
  const hook = {
    runner: 'claude',
    tmuxPane: '%1',
    session_id: session,
    rootSessionId: session,
    transcript_path: file,
    hook_event_name: 'SubagentStop',
    observedAt: now,
    turnStartedAt: now - 5000,
    turnActive: true,
  };
  fs.writeFileSync(path.join(dir, 'panes', '%251.json'), JSON.stringify(hook));
  fs.writeFileSync(path.join(dir, 'hooks.jsonl'), JSON.stringify(hook) + '\n');
  const record = (type, offset, content, extra = {}) => ({
    type,
    isSidechain: false,
    sessionId: session,
    session_id: session,
    timestamp: new Date(now + offset).toISOString(),
    promptId: 'prompt-one',
    uuid: 'event-' + offset,
    parentUuid: 'previous',
    message: { role: type, content },
    ...extra,
  });
  const records = [
    record('user', -5000, [{ type: 'text', text: 'Check the retained task' }]),
    record('assistant', -2000, [{ type: 'thinking', thinking: 'checking' }]),
    record('user', -1000, [{ type: 'text', text: '[Request interrupted by user]' }]),
    record('assistant', -500, [{ type: 'text', text: 'child completion' }], { isSidechain: true }),
  ];
  const write = () => fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
  const meta = { pane_id: '%1', process_started_at: now - 10000 };
  write();
  const idle = nativeState(meta, 'claude', dir);
  assert.equal(idle.phase, 'idle');
  assert.equal(idle.source, 'native-session');
  records.push(
    record('assistant', 1, [{ type: 'tool_use', id: 'next-tool', name: 'Read', input: {} }]),
  );
  write();
  assert.equal(
    nativeState(meta, 'claude', dir).phase,
    'busy',
    'later parent work vetoes the old interruption',
  );
  records.pop();
  records.push(
    record('user', 2, [{ type: 'text', text: 'New parent request' }], { promptId: 'prompt-two' }),
  );
  write();
  assert.equal(
    nativeState(meta, 'claude', dir).phase,
    'busy',
    'a later parent prompt is not the interrupted turn',
  );
});
