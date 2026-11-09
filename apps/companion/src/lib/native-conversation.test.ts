import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  NativeCommandReceipt,
  NativeSessionEvent,
  NativeSessionReadResult,
} from '@farmslot/protocol';
import { nativeTimeline, nativeTimelineRows } from '@farmslot/protocol/client-cache';

import {
  nativeConversationWritable,
  nativeRetryAvailable,
  nativeTranscriptItemKey,
  nativeTranscriptItemType,
  nativeTranscriptList,
} from './native-conversation';

function event(
  sequence: number,
  type: NativeSessionEvent['type'],
  text?: string,
): NativeSessionEvent {
  return {
    sessionId: 'session',
    generation: 'generation',
    sequence,
    type,
    commandId: 'command',
    at: '2026-09-12T00:00:00Z',
    text,
  };
}
function page(events: NativeSessionEvent[]): NativeSessionReadResult {
  return {
    session: {
      id: 'session',
      generation: 'generation',
      hostPid: 0,
      runner: 'fixture',
      nativeSessionId: 'conversation',
      ownerPrincipalId: 'owner',
      executionNodeId: 'local',
      accountContextId: 'owner',
      cwd: '/fixture',
      executable: '',
      version: 'fixture',
      mode: 'default',
      accountMode: 'native',
      state: 'idle',
      capabilities: {
        modes: ['default'],
        streaming: true,
        tools: true,
        approvals: true,
        questions: true,
        interrupt: true,
        resume: true,
      },
    },
    events,
    cursor: events.at(-1)?.sequence ?? 0,
    hasMore: false,
    commands: [],
    pendingRequests: [],
  };
}

test("the message field stays open while a streaming worker's history only waits for its reread", () => {
  const now = Date.parse('2026-10-30T00:00:00Z');
  const snapshot = {
    ...page([event(1, 'text.delta', 'streaming')]),
    session: { ...page([]).session, state: 'running' as const },
  };
  const stamp = { epoch: 'epoch', dependencies: [] };
  const live = { status: 'stale' as const, data: snapshot, observedAt: now, resourceState: stamp };
  const input = {
    allowed: true,
    ready: true,
    connected: true,
    history: live,
    snapshot,
    workerControl: false,
    now,
  };
  assert.equal(nativeConversationWritable(input), true, 'a change notice keeps input open');
  const superseded = { code: 'RESOURCE_OBSERVATION_CHANGED', message: 'changed' };
  assert.equal(
    nativeConversationWritable({ ...input, history: { ...live, error: superseded } }),
    true,
  );
  assert.equal(
    nativeConversationWritable({
      ...input,
      history: { ...live, error: superseded },
      now: now + 60_000,
    }),
    false,
    'reads superseded for 60 s count as saved',
  );
  const failed = { code: 'NATIVE_SOURCE_UNAVAILABLE', message: 'unavailable' };
  assert.equal(
    nativeConversationWritable({ ...input, history: { ...live, error: failed } }),
    false,
  );
  assert.equal(nativeConversationWritable({ ...input, connected: false }), false);
  const { resourceState: _, ...restored } = live;
  assert.equal(
    nativeConversationWritable({ ...input, history: restored }),
    false,
    'storage waits for a live read',
  );
  const worker = { ...snapshot, session: { ...snapshot.session, workerManaged: true } };
  const run = { status: 'stale' as const, data: {}, observedAt: now };
  const workerInput = {
    ...input,
    snapshot: worker,
    history: { ...live, data: worker },
    workerControl: true,
  };
  assert.equal(
    nativeConversationWritable({ ...workerInput, run }),
    true,
    'a run write does not lock a worker',
  );
  assert.equal(
    nativeConversationWritable({ ...workerInput, run: { ...run, error: failed } }),
    false,
  );
});

test('a queued message waits for its turn instead of offering a retry', () => {
  const receipt = (
    state: NativeCommandReceipt['state'],
    queued?: boolean,
  ): NativeCommandReceipt => ({
    generation: 'generation',
    commandId: 'command',
    state,
    submitted: !queued,
    accepted: false,
    ...(queued ? { queued } : {}),
  });
  assert.equal(nativeRetryAvailable(undefined), true);
  assert.equal(nativeRetryAvailable(receipt('pending')), true);
  assert.equal(nativeRetryAvailable(receipt('unknown')), true);
  assert.equal(nativeRetryAvailable(receipt('pending', true)), false);
  assert.equal(nativeRetryAvailable(receipt('accepted')), false);
  assert.equal(nativeRetryAvailable(receipt('completed')), false);
});

test("the conversation list drops a closed fold's tools and keeps its keys", () => {
  const tool = (sequence: number, type: NativeSessionEvent['type']): NativeSessionEvent => ({
    ...event(sequence, type),
    nativeId: 'tool-1',
    tool: {
      name: 'Bash',
      kind: 'command',
      command: 'ls',
      status: type === 'tool.completed' ? 'completed' : 'running',
    },
  });
  const events: NativeSessionEvent[] = [
    event(1, 'command.submitted', 'hello'),
    tool(2, 'tool.started'),
    tool(3, 'tool.completed'),
    event(4, 'text.delta', 'done'),
    event(5, 'turn.completed'),
  ];
  const rows = nativeTimelineRows(nativeTimeline(events));
  const work = rows.find((row) => row.kind === 'work');
  assert.ok(work);
  const toolRow = rows.find((row) => row.kind === 'entry' && row.entry.kind === 'tool');
  assert.ok(toolRow?.kind === 'entry' && toolRow.fold === work.key);
  const request: NativeSessionEvent = {
    ...event(6, 'question.requested'),
    request: { id: 'q1', title: 'Which one?' },
  };

  const closed = nativeTranscriptList(rows, () => false, 'command-2', [request]);
  assert.equal(closed.items.includes(toolRow), false);
  assert.equal(closed.openFolds.has(work.key), false);
  assert.deepEqual(closed.items.map(nativeTranscriptItemKey), [
    ...rows
      .filter((row) => row !== toolRow)
      .map((row) => (row.kind === 'work' ? `work:${row.key}` : String(row.key))),
    'command-2',
    'generation:q1',
  ]);

  const open = nativeTranscriptList(rows, (key) => key === work.key, undefined, []);
  assert.equal(open.openFolds.has(work.key), true);
  // Rows are the items themselves, so a kept row is the same cell item.
  assert.deepEqual(open.items, rows);
  assert.equal(open.items[1], rows[1]);
  assert.equal(nativeTranscriptItemType(toolRow), 'tool');
  assert.equal(nativeTranscriptItemType(work), 'work');
});
