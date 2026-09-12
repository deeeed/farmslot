import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claudeNativeAdapter } from './claude.js';

const fakeClaude = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const sessionFlag = process.argv.includes('--resume') ? '--resume' : '--session-id';
const sessionId = process.argv[process.argv.indexOf(sessionFlag) + 1];
let delayedUser;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
writeFileSync(process.env.FARMSLOT_NATIVE_INVOCATION, JSON.stringify(process.argv.slice(2)));
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
    if (process.argv.includes('--resume')) send({ type: 'system', subtype: 'hook_started', session_id: 'temporary-startup-session' });
    send({ type: 'system', subtype: 'init', session_id: sessionId });
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    return;
  }
  if (message.type === 'user') {
    if (process.env.FARMSLOT_NATIVE_DELAY_REPLAY) delayedUser = message.message;
    else send({ type: 'user', session_id: sessionId, message: message.message });
    if (message.message.content === 'question') {
      send({ type: 'control_request', session_id: sessionId, request_id: 'question-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }] }, tool_use_id: 'tool-question' } });
      return;
    }
    send({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { id: 'assistant-message-1' } } });
    send({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working' } } });
    send({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }] } });
    send({ type: 'control_request', session_id: sessionId, request_id: 'approval-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' }, tool_use_id: 'tool-1' } });
    return;
  }
  if (message.type === 'control_response' && message.response?.request_id === 'approval-1') {
    if (delayedUser) send({ type: 'user', session_id: sessionId, message: delayedUser });
    send({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } });
    send({ type: 'result', session_id: sessionId, subtype: 'success', is_error: false });
    return;
  }
  if (message.type === 'control_response' && message.response?.request_id === 'question-1') {
    writeFileSync(process.env.FARMSLOT_NATIVE_RESPONSE, JSON.stringify(message.response.response));
    send({ type: 'result', session_id: sessionId, subtype: 'success', is_error: false });
    return;
  }
  if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    send({ type: 'result', session_id: sessionId, subtype: 'success', is_error: false });
  }
});
`;

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'farmslot-claude-native-'));
  const executable = path.join(directory, 'claude');
  const invocation = path.join(directory, 'invocation.json');
  const response = path.join(directory, 'response.json');
  await writeFile(executable, fakeClaude);
  await chmod(executable, 0o755);
  return { executable, invocation, response };
}

async function waitFor(events: Array<Record<string, unknown>>, type: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (events.some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

test('Claude maps acknowledged interruption followed by a successful result to interrupted', async () => {
  const { executable, invocation } = await fixture();
  const events: Array<Record<string, unknown>> = [];
  const session = await claudeNativeAdapter.start(
    {
      cwd: process.cwd(),
      executable,
      env: { ...process.env, FARMSLOT_NATIVE_INVOCATION: invocation },
    },
    (event) => events.push(event),
  );
  try {
    await session.send('inspect this', 'interrupt-command');
    await waitFor(events, 'approval.requested');
    await session.interrupt();
    await waitFor(events, 'turn.completed');
    assert.equal(events.find((event) => event.type === 'turn.completed')?.status, 'interrupted');
  } finally {
    await session.close();
  }
});

test('Claude stream-json adapter preserves structured session, turn, tool, and approval events', async () => {
  const { executable, invocation } = await fixture();
  const events: Array<Record<string, unknown>> = [];
  const session = await claudeNativeAdapter.start(
    {
      cwd: process.cwd(),
      executable,
      model: 'sonnet',
      env: { ...process.env, FARMSLOT_NATIVE_INVOCATION: invocation },
    },
    (event) => events.push(event),
  );

  assert.match(session.nativeSessionId, /^[a-f0-9-]{36}$/);
  await session.send('inspect this', 'command-1');
  await waitFor(events, 'approval.requested');
  await session.respond('approval-1', { decision: 'approve' });
  await waitFor(events, 'turn.completed');

  assert.deepEqual(
    events.map((event) => event.type),
    [
      'session.started',
      'command.accepted',
      'turn.started',
      'text.delta',
      'tool.started',
      'approval.requested',
      'approval.resolved',
      'tool.completed',
      'turn.completed',
    ],
  );
  assert.equal(events.find((event) => event.type === 'text.delta')?.text, 'Working');
  assert.equal(
    events.find((event) => event.type === 'turn.started')?.nativeId,
    'assistant-message-1',
  );
  assert.equal(events.find((event) => event.type === 'approval.requested')?.nativeId, 'approval-1');
  const args = JSON.parse(await readFile(invocation, 'utf8')) as string[];
  assert.deepEqual(args, [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--permission-prompt-tool',
    'stdio',
    '--model',
    'sonnet',
    '--session-id',
    session.nativeSessionId,
  ]);
  await session.close();
});

test('Claude stream-json adapter resumes the exact native session id', async () => {
  const { executable, invocation } = await fixture();
  const session = await claudeNativeAdapter.start(
    {
      cwd: process.cwd(),
      executable,
      resumeSessionId: 'claude-session-1',
      env: { ...process.env, FARMSLOT_NATIVE_INVOCATION: invocation },
    },
    () => {},
  );
  assert.equal(session.nativeSessionId, 'claude-session-1');
  const args = JSON.parse(await readFile(invocation, 'utf8')) as string[];
  assert.deepEqual(args.slice(-2), ['--resume', 'claude-session-1']);
  await session.close();
});

test('Claude stream-json adapter answers native questions by question text', async () => {
  const { executable, invocation, response: responsePath } = await fixture();
  const events: Array<Record<string, unknown>> = [];
  const session = await claudeNativeAdapter.start(
    {
      cwd: process.cwd(),
      executable,
      env: {
        ...process.env,
        FARMSLOT_NATIVE_INVOCATION: invocation,
        FARMSLOT_NATIVE_RESPONSE: responsePath,
      },
    },
    (event) => events.push(event),
  );
  await session.send('question', 'command-question');
  await waitFor(events, 'question.requested');
  await session.respond('question-1', { answers: { Choose: ['B'] } });
  await waitFor(events, 'turn.completed');
  const sent = JSON.parse(await readFile(responsePath, 'utf8')) as {
    updatedInput: { answers: Record<string, string> };
  };
  assert.equal(sent.updatedInput.answers.Choose, 'B');
  await session.close();
});

test('Claude initialization accepts a configured session ID without an early native echo', async () => {
  const { executable } = await fixture();
  await writeFile(
    executable,
    `#!/usr/bin/env node
const {createInterface}=require('node:readline');
createInterface({input:process.stdin}).on('line', line => {
 const message=JSON.parse(line);
 process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{}}})+'\\n');
});`,
  );
  const events: Array<Record<string, unknown>> = [];
  const session = await claudeNativeAdapter.start({ cwd: process.cwd(), executable }, (event) =>
    events.push(event),
  );
  assert.match(session.nativeSessionId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(events[0]?.data, { identityConfirmed: false });
  await session.close();
});

test('Claude startup preserves process failure instead of rejecting undefined', async () => {
  const { executable } = await fixture();
  await writeFile(executable, '#!/usr/bin/env node\nprocess.exit(1);\n');
  await assert.rejects(
    claudeNativeAdapter.start({ cwd: process.cwd(), executable }, () => {}),
    /Native runner exited: code=1/,
  );
});

test('Claude correlates output before replay and allows permission responses while acceptance is pending', async () => {
  const { executable, invocation } = await fixture();
  const events: Array<Record<string, unknown>> = [];
  const session = await claudeNativeAdapter.start(
    {
      cwd: process.cwd(),
      executable,
      env: {
        ...process.env,
        FARMSLOT_NATIVE_INVOCATION: invocation,
        FARMSLOT_NATIVE_DELAY_REPLAY: '1',
      },
    },
    (event) => events.push(event),
  );
  try {
    await session.send('delayed replay', 'pending-command');
    await waitFor(events, 'approval.requested');
    assert.equal(
      events.some((event) => event.type === 'command.accepted'),
      false,
    );
    for (const type of ['turn.started', 'text.delta', 'approval.requested']) {
      assert.equal(events.find((event) => event.type === type)?.commandId, 'pending-command');
    }
    await session.respond('approval-1', { decision: 'approve' });
    await waitFor(events, 'turn.completed');
    assert.equal(
      events.find((event) => event.type === 'command.accepted')?.commandId,
      'pending-command',
    );
    assert.equal(
      events.find((event) => event.type === 'turn.completed')?.commandId,
      'pending-command',
    );
  } finally {
    await session.close();
  }
});
