import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateAnswer } from '../scripts/driver.mjs';
import { transcriptQuestion } from '../scripts/native-evidence.mjs';

const user = (text) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});
const ask = (
  call = 'q1',
  name = 'request_user_input_async',
  questions = [{ title: 'Which URL?', options: ['Local', 'Hosted'] }],
) => ({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name,
    id: `fc_${call}`,
    call_id: call,
    arguments: JSON.stringify({ questions }),
  },
});
const accepted = (call = 'q1', output = '{"accepted":true}') => ({
  type: 'response_item',
  payload: { type: 'function_call_output', call_id: call, output },
});
const reply = (call = 'q1', index = 0) =>
  user(
    '<send_user_message_question_reply>\n' +
      JSON.stringify([
        {
          answer: 'https://example.test',
          question: 'Which URL?',
          questionItemId: JSON.stringify(['request_user_input_async', call, index]),
        },
      ]) +
      '\n</send_user_message_question_reply>',
  );

function log(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-async-question-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
  return file;
}

for (const name of ['request_user_input_async', 'functions.request_user_input_async']) {
  test(`${name} remains pending after its immediate acknowledgement`, (t) => {
    const file = log(t, [user('Work'), ask('q1', name), accepted()]);
    const question = transcriptQuestion(file);
    assert.equal(question.tool, name);
    assert.equal(question.call_id, 'q1');
    assert.deepEqual(question.questions, [{ title: 'Which URL?', options: ['Local', 'Hosted'] }]);
    assert.deepEqual(question.question_item_ids, [
      JSON.stringify(['request_user_input_async', 'q1', 0]),
    ]);
  });
}

test('matching user replies resolve only the answered question', (t) => {
  const file = log(t, [
    user('Work'),
    ask('q1', undefined, [{ title: 'First?' }, { title: 'Second?' }]),
    accepted(),
    reply('q1', 0),
  ]);
  assert.deepEqual(transcriptQuestion(file).questions, [{ title: 'Second?' }]);
  assert.deepEqual(transcriptQuestion(file).question_item_ids, [
    JSON.stringify(['request_user_input_async', 'q1', 1]),
  ]);
  fs.appendFileSync(file, JSON.stringify(reply('q1', 1)) + '\n');
  assert.equal(transcriptQuestion(file), null);
});

test('an answer to another call does not close this question', (t) => {
  const file = log(t, [user('Work'), ask(), accepted(), reply('different')]);
  assert.equal(transcriptQuestion(file).call_id, 'q1');
});

test('a new ordinary prompt and a completed turn expire old async questions', (t) => {
  for (const ending of [
    user('New task'),
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ]) {
    const file = log(t, [user('Work'), ask(), accepted(), ending]);
    assert.equal(transcriptQuestion(file), null);
  }
});

test('questions outside the recent log window remain visible while work continues', (t) => {
  const file = log(t, [
    user('Work'),
    ask(),
    accepted(),
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'work',
        output: 'x'.repeat(9 * 1024 * 1024),
      },
    },
  ]);
  assert.equal(transcriptQuestion(file).call_id, 'q1');
});

test('a rejected async request never becomes an answerable question', (t) => {
  const file = log(t, [user('Work'), ask(), accepted('q1', 'question titles must not be empty')]);
  assert.equal(transcriptQuestion(file), null);
});

test('queued questions are returned in the same order as the native question editor', (t) => {
  const file = log(t, [
    user('Work'),
    ask('first'),
    accepted('first'),
    ask('second'),
    accepted('second'),
  ]);
  assert.equal(transcriptQuestion(file).call_id, 'first');
});

test('explicit queue navigation and text answers use the existing action grammar', () => {
  const actions = ['S-Left', { text: 'https://example.test' }, 'Enter'];
  assert.deepEqual(validateAnswer(actions), actions);
  assert.throws(() => validateAnswer(['C-c']), /Only explicit/);
});
