import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runNative } from '../scripts/native-target.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-driver-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const descriptor = {
    gateway: 'proof',
    sessionId: 'session',
    executionNodeId: 'local',
    generation: 'generation',
    worker: { runId: 'run', contextId: 'dev', generation: 'worker-generation', leaseId: 'lease' },
  };
  const file = path.join(dir, 'target.json');
  fs.writeFileSync(file, JSON.stringify(descriptor));
  const page = {
    session: {
      id: descriptor.sessionId,
      generation: descriptor.generation,
      runner: 'codex',
      executionNodeId: 'local',
      workerManaged: true,
      workerLeaseId: 'lease',
      state: 'idle',
    },
    events: [],
    commands: [],
    pendingRequests: [],
    cursor: 0,
    hasMore: false,
    scope: { leaseId: 'lease', startAfter: 0, endAt: 0, released: false },
  };
  const sent = [],
    calls = [];
  let closed = 0;
  const connection = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'native.session.read') return structuredClone(page);
      if (method === 'native.session.send') {
        // Receipt exists before the first network mutation, even on a failed request.
        const files = fs
          .readdirSync(path.join(dir, 'state'), { recursive: true })
          .filter((name) => name.endsWith('.json'));
        const receipts = files.map((name) =>
          JSON.parse(fs.readFileSync(path.join(dir, 'state', name))),
        );
        assert.ok(receipts.some((r) => r.commandId === params.commandId && r.payloadHash));
        sent.push(params);
        return { commandId: params.commandId, state: 'accepted', submitted: true, accepted: true };
      }
      if (method === 'native.session.respond') return {};
      throw new Error(`Unexpected RPC ${method}`);
    },
    close() {
      closed++;
    },
  };
  const options = {
    stateDir: path.join(dir, 'state'),
    connect: async (gateway) => {
      assert.equal(gateway, 'proof');
      return { connection, url: 'ws://fixture' };
    },
  };
  const invoke = (args = {}) =>
    runNative(
      { operation: 'send', target: `native:${file}`, runner: 'codex', input: 'hello', ...args },
      options,
    );
  return { dir, descriptor, file, page, sent, calls, connection, invoke, closed: () => closed };
}

test('native send persists a command before RPC; retry reuses it and keeps worker pins', async (t) => {
  const f = fixture(t);
  const a = await f.invoke();
  const b = await f.invoke();
  assert.equal(a.submitted, true);
  assert.equal(a.verification, 'submitted');
  assert.equal(b.evidence.commandId, a.evidence.commandId);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].commandId, f.sent[1].commandId);
  assert.deepEqual(f.sent[0].worker, f.descriptor.worker);
  assert.equal(f.sent[0].executionNodeId, 'local');
  assert.equal(f.closed(), 2);
});

test('lost send reply retains commandId; native queue is delivery, submitted alone is not', async (t) => {
  const f = fixture(t);
  let mode = 'lost';
  const original = f.connection.call;
  f.connection.call = async (method, params) => {
    const result = await original(method, params);
    if (method !== 'native.session.send') return result;
    if (mode === 'lost') throw new Error('Connection closed unexpectedly');
    return { ...result, state: 'pending', accepted: false, queued: mode === 'queued' };
  };
  const lost = await f.invoke();
  assert.equal(lost.submitted, false);
  assert.equal(lost.verification, 'unverified');
  mode = 'submitted';
  const uncertain = await f.invoke();
  assert.equal(uncertain.submitted, false);
  assert.equal(uncertain.verification, 'unverified');
  mode = 'queued';
  const queued = await f.invoke();
  assert.equal(queued.submitted, true);
  assert.equal(queued.verification, 'queued');
  assert.equal(new Set(f.sent.map((s) => s.commandId)).size, 1);
});

test('stream receipt reconciles delivery without another mutation, including cancellation', async (t) => {
  const f = fixture(t);
  const first = await f.invoke();
  f.page.commands = [
    {
      commandId: first.evidence.commandId,
      generation: 'generation',
      state: 'completed',
      submitted: true,
      accepted: true,
      outcome: 'completed',
    },
  ];
  assert.equal((await f.invoke()).verification, 'submitted');
  assert.equal(f.sent.length, 1);
  f.page.commands[0] = {
    ...f.page.commands[0],
    accepted: false,
    queued: false,
    outcome: 'cancelled',
  };
  assert.equal((await f.invoke()).submitted, false);
  assert.equal(f.sent.length, 1);
});

for (const [label, change] of [
  [
    'runner',
    (f) => {
      f.page.session.runner = 'claude';
    },
  ],
  [
    'session generation',
    (f) => {
      f.page.session.generation = 'successor';
    },
  ],
  [
    'worker lease',
    (f) => {
      f.page.scope.leaseId = 'successor';
    },
  ],
  [
    'released lease',
    (f) => {
      f.page.scope.released = true;
    },
  ],
])
  test(`stale ${label} refuses before send`, async (t) => {
    const f = fixture(t);
    change(f);
    assert.equal((await f.invoke()).submitted, false);
    assert.equal(f.sent.length, 0);
  });

test('gateway permission refusal never sends or acquires alternate credentials', async (t) => {
  const f = fixture(t);
  f.connection.call = async () => {
    throw Object.assign(new Error('Forbidden'), { code: 'AUTH_FORBIDDEN' });
  };
  await assert.rejects(f.invoke(), /Forbidden/);
  assert.equal(f.closed(), 1);
  assert.equal(f.sent.length, 0);
});

function question(f) {
  f.page.pendingRequests = [
    {
      sessionId: 'session',
      generation: 'generation',
      type: 'question.requested',
      sequence: 1,
      request: {
        id: 'request',
        title: 'Pick',
        questions: [
          {
            id: 'color',
            prompt: 'Which color?',
            options: [{ label: 'Violet' }, { label: 'Green' }],
          },
        ],
      },
    },
  ];
}

test('pending native question is structured, blocks send, answers only a matching explicit option', async (t) => {
  const f = fixture(t);
  question(f);
  const pending = await f.invoke();
  assert.equal(pending.verification, 'pending_question');
  assert.equal(pending.submitted, false);
  assert.equal(pending.question.questions[0].prompt, 'Which color?');
  assert.deepEqual(pending.question.questions[0].options, [
    { label: 'Violet' },
    { label: 'Green' },
  ]);
  assert.equal(f.sent.length, 0);
  const answer = {
    operation: 'answer',
    argument: pending.question_fingerprint,
    input: JSON.stringify({ answers: { color: ['Violet'] } }),
  };
  assert.equal((await f.invoke(answer)).action_sent, true);
  assert.deepEqual(f.calls.at(-1).params, {
    sessionId: 'session',
    executionNodeId: 'local',
    worker: f.descriptor.worker,
    requestId: 'request',
    answers: { color: ['Violet'] },
  });
  f.page.pendingRequests[0].request.id = 'new-request';
  assert.equal((await f.invoke(answer)).action_sent, undefined);
  assert.equal(f.calls.filter((c) => c.method === 'native.session.respond').length, 1);
});

test('unknown response outcome is not replayed automatically', async (t) => {
  const f = fixture(t);
  question(f);
  const state = await f.invoke({ operation: 'state' });
  const original = f.connection.call;
  f.connection.call = async (method, params) => {
    const result = await original(method, params);
    if (method === 'native.session.respond') throw new Error('Reply lost');
    return result;
  };
  const input = {
    operation: 'answer',
    argument: state.question_fingerprint,
    input: '{"answers":{"color":["Violet"]}}',
  };
  assert.equal((await f.invoke(input)).verification, 'unverified');
  assert.equal((await f.invoke(input)).verification, 'unverified');
  assert.equal(f.calls.filter((c) => c.method === 'native.session.respond').length, 1);
});

test('native read returns conversation events and cursor, never capture-pane', async (t) => {
  const f = fixture(t);
  f.page.events = [{ type: 'text.delta', text: 'reply', sequence: 12 }];
  f.page.cursor = 12;
  const result = await f.invoke({ operation: 'read', argument: '11' });
  assert.deepEqual(result.events, f.page.events);
  assert.equal(result.cursor, 12);
  assert.equal(f.calls[0].params.after, 11);
});

test('explicit acknowledgement allows an intentional same-text new turn', async (t) => {
  const f = fixture(t);
  const first = await f.invoke();
  f.page.commands = [
    {
      commandId: first.evidence.commandId,
      generation: 'generation',
      state: 'accepted',
      submitted: true,
      accepted: true,
    },
  ];
  assert.equal(
    (await f.invoke({ operation: 'ack', argument: first.receipt_id })).acknowledged,
    true,
  );
  const next = await f.invoke();
  assert.notEqual(next.evidence.commandId, first.evidence.commandId);
  assert.equal(
    (await f.invoke({ operation: 'ack', argument: first.receipt_id })).acknowledged,
    true,
  );
  assert.equal((await f.invoke()).evidence.commandId, next.evidence.commandId);
});

test('another native send holds the same target lock; it cannot submit concurrently', async (t) => {
  const f = fixture(t);
  let entered, release;
  const ready = new Promise((r) => {
    entered = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  const original = f.connection.call;
  f.connection.call = async (method, params) => {
    if (method === 'native.session.send') {
      entered();
      await gate;
    }
    return original(method, params);
  };
  const first = f.invoke();
  try {
    await ready;
    assert.equal((await f.invoke()).verification, 'driver_busy');
  } finally {
    release();
    await first;
  }
  assert.equal(f.sent.length, 1);
});

test('confirmed answer cannot claim a different response was sent', async (t) => {
  const f = fixture(t);
  question(f);
  const state = await f.invoke({ operation: 'state' });
  const args = {
    operation: 'answer',
    argument: state.question_fingerprint,
    input: '{"answers":{"color":["Violet"]}}',
  };
  assert.equal((await f.invoke(args)).action_sent, true);
  const other = await f.invoke({ ...args, input: '{"answers":{"color":["Green"]}}' });
  assert.equal(other.action_sent, false);
  assert.equal(other.verification, 'response_mismatch');
  assert.equal(f.calls.filter((c) => c.method === 'native.session.respond').length, 1);
});

test('native descriptor has no URL/token override and unsupported commands never connect', async (t) => {
  const f = fixture(t);
  assert.equal(
    (await f.invoke({ operation: 'flush' })).verification,
    'unsupported_native_operation',
  );
  assert.equal(f.closed(), 0);
  fs.writeFileSync(f.file, JSON.stringify({ ...f.descriptor, token: 'not-allowed' }));
  await assert.rejects(f.invoke(), /requires gateway profile/);
  assert.equal(f.closed(), 0);
});

for (const runner of ['claude', 'pi', 'opencode', 'grok']) {
  test(`native ${runner} uses the same protocol without runner-specific delivery`, async (t) => {
    const f = fixture(t);
    f.page.session.runner = runner;
    const result = await f.invoke({ runner });
    assert.equal(result.submitted, true);
    assert.equal(result.state, runner);
  });
}

test('descriptor formatting does not change native retry identity', async (t) => {
  const f = fixture(t);
  const first = await f.invoke();
  const reversed = Object.fromEntries(Object.entries(f.descriptor).reverse());
  reversed.worker = Object.fromEntries(Object.entries(f.descriptor.worker).reverse());
  fs.writeFileSync(f.file, JSON.stringify(reversed));
  const retry = await f.invoke();
  assert.equal(retry.evidence.commandId, first.evidence.commandId);
});
