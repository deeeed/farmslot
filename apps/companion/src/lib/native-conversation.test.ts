import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeSessionEvent, NativeSessionReadResult } from '@farmslot/protocol';

import { nativeConversationWritable } from './native-conversation';

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
