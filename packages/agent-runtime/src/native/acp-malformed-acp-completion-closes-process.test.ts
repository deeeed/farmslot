import assert from 'node:assert/strict';
import test from 'node:test';

import { setup, until } from './acp.test-support.js';
import { acpPermission, cursorRequest } from './acp-requests.js';
import { grokNativeAdapter } from './grok.js';
import type { NativeEventInput } from './types.js';

test('malformed ACP completion closes its process without manufacturing success', async () => {
  const f = setup();
  const events: NativeEventInput[] = [];
  const session = await grokNativeAdapter.start(f, (event) => events.push(event));
  try {
    await session.send('malformed', 'c1');
    await until(() => events.some((e) => e.type === 'session.closed'));
    assert.equal(
      events.some((e) => e.type === 'turn.completed' && e.status === 'completed'),
      false,
    );
    assert.equal(events.at(-1)?.data?.processStopped, true);
    assert.equal(events.at(-1)?.status, 'failed');
  } finally {
    await session.close();
    f.cleanup();
  }
});

test('Cursor question labels map to native IDs and plan approval stays explicit', () => {
  const request = cursorRequest('cursor/ask_question', {
    questions: [
      {
        id: 'q1',
        prompt: 'Choose',
        options: [
          { id: 'wire-red', label: 'Red' },
          { id: 'wire-blue', label: 'Blue' },
        ],
      },
    ],
  })!;
  assert.deepEqual(request.response({ answers: { q1: ['Red'] } }), {
    outcome: {
      outcome: 'answered',
      answers: [{ questionId: 'q1', selectedOptionIds: ['wire-red'] }],
    },
  });
  assert.throws(() => request.response({ answers: { q1: ['unknown'] } }), /Unknown/);
  assert.throws(() => request.response({ answers: { q1: ['Red', 'Blue'] } }), /valid selection/);
  assert.deepEqual(
    cursorRequest('cursor/create_plan', { plan: 'Plan' })!.response({ decision: 'deny' }),
    { outcome: { outcome: 'rejected' } },
  );
  const permission = acpPermission({
    toolCall: { title: 'Action' },
    options: [{ kind: 'allow_always', optionId: 'all' }],
  });
  assert.throws(() => permission.response({ decision: 'approve' }), /one-time/);
  assert.deepEqual(permission.response({ decision: 'deny' }), {
    outcome: { outcome: 'cancelled' },
  });
});

test('ACP permission updates can omit previously streamed tool fields', () => {
  const request = acpPermission(
    { toolCall: { toolCallId: 'existing' }, options: [{ optionId: 'one', kind: 'allow_once' }] },
    { name: 'Existing tool', input: { command: 'fixture' } },
  );
  assert.equal(request.event.request?.title, 'Existing tool');
  assert.deepEqual(request.event.request?.tool?.input, { command: 'fixture' });
  assert.deepEqual(request.response({ decision: 'approve' }), {
    outcome: { outcome: 'selected', optionId: 'one' },
  });
});
