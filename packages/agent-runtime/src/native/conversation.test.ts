import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  NativeConversationUpdate,
  NativeSessionEvent,
  NativeSessionReadResult,
} from '@farmslot/protocol';

import {
  NativeConversationJournal,
  NativeConversationSubscription,
  splitNativeText,
} from './conversation.js';

const session: NativeSessionReadResult['session'] = {
  id: 'session',
  generation: 'generation',
  hostPid: 1,
  runner: 'codex',
  nativeSessionId: 'conversation',
  ownerPrincipalId: 'owner',
  executionNodeId: 'mini',
  accountContextId: 'ambient',
  cwd: '/work',
  executable: '/bin/codex',
  version: '1',
  mode: 'default',
  accountMode: 'native',
  state: 'running',
  capabilities: {
    modes: ['default'],
    streaming: true,
    tools: true,
    approvals: true,
    questions: true,
    interrupt: true,
    resume: true,
  },
};
const event = (sequence: number, text = 'x'): NativeSessionEvent => ({
  sessionId: session.id,
  generation: session.generation,
  sequence,
  at: '2026-11-06T00:00:00Z',
  type: 'text.delta',
  commandId: 'command',
  text,
});
const page = (events: NativeSessionEvent[]): NativeSessionReadResult => ({
  session,
  events,
  commands: [],
  pendingRequests: [],
  cursor: events.at(-1)?.sequence ?? 0,
  hasMore: false,
});

test('a listener armed at high water sees each later committed event once', () => {
  const journal = new NativeConversationJournal('host');
  journal.commit(page([event(1, 'before')]));
  const seen: number[] = [];
  const stop = journal.listen(() => seen.push(journal.sequence));
  const initial = journal.resume();
  assert.equal(initial.kind, 'reset');
  journal.commit(page([event(2, 'after')]));
  assert.deepEqual(seen, [2]);
  assert.equal(journal.sequence, 2);
  stop();
  journal.commit(page([event(3)]));
  assert.deepEqual(seen, [2]);
});

test('bounded replay resets an obsolete/ahead/foreign cursor and retains the active prefix', () => {
  const journal = new NativeConversationJournal('host');
  for (let i = 1; i <= 140; i++) journal.commit(page([event(i)]));
  const current = {
    hostGeneration: 'host',
    executionNodeId: 'mini',
    sessionId: 'session',
    generation: 'generation',
    sequence: 139,
  };
  const replay = journal.resume(current);
  assert.equal(replay.kind, 'replay');
  if (replay.kind === 'replay')
    assert.deepEqual(
      replay.page.events.map((e) => e.sequence),
      [140],
    );
  for (const after of [
    { ...current, sequence: 0 },
    { ...current, sequence: 141 },
    { ...current, hostGeneration: 'old-host' },
    { ...current, generation: 'old' },
    { ...current, executionNodeId: 'other' },
  ]) {
    const reset = journal.resume(after);
    assert.equal(reset.kind, 'reset');
    if (reset.kind === 'reset') {
      assert.equal(
        reset.snapshot.events
          .filter((e) => e.type === 'text.delta')
          .map((e) => e.text)
          .join(''),
        'x'.repeat(140),
      );
      assert.equal(reset.cursor.sequence, 140);
    }
  }
});

test('text splitting preserves utf8 bytes and bounds encoded events, including escaped characters', () => {
  const text = '😀\n"\\'.repeat(100_000);
  const parts = splitNativeText(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => Buffer.byteLength(JSON.stringify(event(1, part))) < 64 * 1024));
});

test('reset and metadata are bounded, oversized active prefix has a journal continuation', () => {
  const journal = new NativeConversationJournal('host');
  for (let i = 1; i <= 40; i++) journal.commit(page([event(i, 'x'.repeat(60_000))]));
  const reset = journal.resume();
  assert.ok(Buffer.byteLength(JSON.stringify(reset)) <= 1024 * 1024);
  assert.equal(reset.kind, 'reset');
  if (reset.kind === 'reset') {
    assert.equal(reset.snapshot.truncated, true);
    assert.ok(reset.snapshot.activePrefixAfter !== undefined);
  }
});

test('live delivery waits for the initial result and batches new events within fifty milliseconds', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const journal = new NativeConversationJournal('host');
  journal.commit(page([event(1, 'initial')]));
  const delivered: NativeConversationUpdate[] = [];
  const subscription = new NativeConversationSubscription(journal, undefined, (update) =>
    delivered.push(update),
  );
  journal.commit(page([event(2, 'new')]));
  t.mock.timers.tick(100);
  assert.equal(delivered.length, 0, 'initial result must precede queued live delivery');
  subscription.start();
  t.mock.timers.tick(49);
  assert.equal(delivered.length, 0);
  t.mock.timers.tick(1);
  assert.equal(delivered.length, 1);
  const update = delivered[0];
  assert.equal(update.kind, 'delta');
  if (update.kind === 'delta') {
    assert.deepEqual(
      update.page.events.map((e) => e.sequence),
      [2],
    );
    assert.equal(update.page.events.map((e) => e.text).join(''), 'new');
  }
  subscription.stop();
  journal.commit(page([event(3, 'unobserved')]));
  t.mock.timers.tick(1000);
  assert.equal(delivered.length, 1);
});

test('sixty-four kilobytes flush immediately without cumulative assistant text', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const journal = new NativeConversationJournal('host');
  journal.commit(page([event(1, 'initial')]));
  const delivered: NativeConversationUpdate[] = [];
  const subscription = new NativeConversationSubscription(journal, undefined, (update) =>
    delivered.push(update),
  );
  subscription.start();
  journal.commit(page([event(2, 'a'.repeat(60_000))]));
  journal.commit(page([event(3, 'b'.repeat(10_000))]));
  assert.equal(delivered.length, 1);
  const update = delivered[0];
  assert.equal(update.kind, 'delta');
  if (update.kind === 'delta')
    assert.deepEqual(
      update.page.events.map((e) => e.sequence),
      [2, 3],
    );
  subscription.stop();
});

test('a paused subscriber overflows explicitly after one MiB and never silently drops events', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const journal = new NativeConversationJournal('host');
  journal.commit(page([event(1)]));
  const delivered: NativeConversationUpdate[] = [];
  const subscription = new NativeConversationSubscription(journal, undefined, (update) =>
    delivered.push(update),
  );
  for (let i = 2; i <= 30; i++) journal.commit(page([event(i, 'x'.repeat(60_000))]));
  assert.deepEqual(delivered, []);
  subscription.start();
  assert.deepEqual(delivered, [{ kind: 'terminal', reason: 'resync-required' }]);
  t.mock.timers.tick(1000);
  assert.equal(delivered.length, 1);
});

test('an info-only committed setting is delivered even though the event cursor is unchanged', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const journal = new NativeConversationJournal('host');
  journal.commit(page([event(1)]));
  const delivered: NativeConversationUpdate[] = [];
  const subscription = new NativeConversationSubscription(journal, undefined, (update) =>
    delivered.push(update),
  );
  subscription.start();
  journal.commit({
    ...page([]),
    cursor: 1,
    session: { ...session, approvalMode: 'ask', approvalModePending: 'bypass' },
  });
  t.mock.timers.tick(50);
  const update = delivered[0];
  assert.equal(update.kind, 'delta');
  if (update.kind === 'delta') {
    assert.equal(update.cursor.sequence, 1);
    assert.deepEqual(update.page.events, []);
    assert(update.page.session);
    assert.equal(update.page.session.approvalModePending, 'bypass');
  }
  subscription.stop();
});

test('an oversized active segment keeps its beginning with a continuation into the original journal', () => {
  const journal = new NativeConversationJournal('host');
  journal.commit(page([event(1, 'ORIGINAL_PREFIX:' + 'a'.repeat(60_000))]));
  for (let i = 2; i <= 40; i++) journal.commit(page([event(i, 'b'.repeat(60_000))]));
  const reset = journal.resume();
  assert.equal(reset.kind, 'reset');
  if (reset.kind === 'reset') {
    const text = reset.snapshot.events
      .filter((e) => e.type === 'text.delta')
      .map((e) => e.text)
      .join('');
    assert.ok(
      text.startsWith('ORIGINAL_PREFIX:'),
      'reconnect must retain the active prefix, not replace it with its tail',
    );
    assert.ok(
      reset.snapshot.activePrefixAfter !== undefined &&
        reset.snapshot.activePrefixAfter < reset.cursor.sequence,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(reset)) <= 1024 * 1024);
  }
});

test('a completed oversized segment keeps its explicit omission window', () => {
  const journal = new NativeConversationJournal('host');
  for (let i = 1; i <= 40; i++) journal.commit(page([event(i, 'x'.repeat(60_000))]));
  journal.commit(
    page([{ ...event(41), type: 'turn.completed', text: undefined, status: 'completed' }]),
  );
  const reset = journal.resume();
  assert.equal(reset.kind, 'reset');
  if (reset.kind === 'reset') {
    assert.equal(reset.snapshot.activePrefixAfter, undefined);
    const [gap] = reset.snapshot.omissions ?? [];
    assert(gap && gap.anchorSequence === 1 && gap.after > 0 && gap.through === 40);
  }
});

test('a recovered generation marks unprojected prior lease events as historical', () => {
  const journal = new NativeConversationJournal('new-host');
  journal.commit({
    ...page([event(241)]),
    scope: { leaseId: 'lease', startAfter: 0, endAt: 241, released: false },
  });
  const reset = journal.resume();
  assert.equal(reset.kind, 'reset');
  if (reset.kind === 'reset') {
    assert.equal(reset.snapshot.historyBefore, 240);
    assert.equal(reset.snapshot.truncated, true);
  }
});

test('oversized request metadata has explicit original-read continuation instead of a reset loop', () => {
  const journal = new NativeConversationJournal('host');
  const pending = {
    ...event(1),
    type: 'approval.requested' as const,
    request: {
      id: 'request',
      kind: 'approval' as const,
      title: 'Approve',
      detail: 'x'.repeat(1_100_000),
    },
  };
  journal.commit({ ...page([event(1)]), pendingRequests: [pending] });
  const reset = journal.resume();
  assert.equal(reset.kind, 'reset');
  if (reset.kind === 'reset') {
    assert.ok(Buffer.byteLength(JSON.stringify(reset)) < 1024 * 1024);
    assert.deepEqual(reset.snapshot.metadataOmitted, { commands: 0, pendingRequests: 1 });
    assert.deepEqual(reset.snapshot.pendingRequests, []);
  }
});

test('text batches carry only appended events and cursor when metadata is unchanged', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const journal = new NativeConversationJournal('host');
  journal.commit(page([]));
  const delivered: NativeConversationUpdate[] = [];
  const subscription = new NativeConversationSubscription(journal, undefined, (update) =>
    delivered.push(update),
  );
  subscription.start();
  journal.commit({ ...journal.metadata!, events: [event(1, 'new text')], cursor: 1 });
  t.mock.timers.tick(50);
  assert.equal(delivered.length, 1);
  const update = delivered[0];
  assert.equal(update.kind, 'delta');
  if (update.kind === 'delta')
    assert.deepEqual(Object.keys(update.page).sort(), ['cursor', 'events']);
  subscription.stop();
});

test('text chunks include their JSON quotes in the journal append bound', () => {
  for (const value of ['x'.repeat(60 * 1024), '\"'.repeat(60 * 1024), '🙂'.repeat(60 * 1024)]) {
    const chunks = splitNativeText(value);
    assert.equal(chunks.join(''), value);
    assert(chunks.every((chunk) => Buffer.byteLength(JSON.stringify(chunk)) <= 60 * 1024));
  }
});
