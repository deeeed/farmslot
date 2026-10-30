import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { NativeCommandReceipt, NativeSessionReadResult } from '@farmslot/protocol';

// The workspace pane pulls CSS and Monaco that node can't load; the gateway client opens sockets.
mock.module('./native-workspace.js', { namedExports: {} });
mock.module('../../gateway-client.js', { namedExports: { gateway: {} } });

const { NativeSessionView } = await import('./native-session-view.js');

/** The private state and methods the tests drive. */
interface View {
  draft: string;
  localCommand?: { commandId: string; text: string };
  poll(): Promise<void>;
}

const text = 'Then reply with only the word NEXT.';

function page(receipt: NativeCommandReceipt): NativeSessionReadResult {
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
      state: 'closed',
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
    events: [],
    cursor: 0,
    hasMore: false,
    commands: [receipt],
    pendingRequests: [],
  };
}

// Built from the prototype so no DOM or render cycle is needed; one fixture read, no rescheduling.
function makeView(receipt: NativeCommandReceipt, draft: string): View {
  const view = Object.create(NativeSessionView.prototype) as View;
  Object.defineProperty(view, 'isConnected', { value: true });
  Object.defineProperty(view, 'updateComplete', { value: Promise.resolve(true) });
  Object.assign(view, {
    requestUpdate: () => undefined,
    schedule: () => undefined,
    followTimeline: () => undefined,
    fixture: { read: async () => page(receipt) },
    selectedId: 'session',
    selectedNodeId: 'local',
    connected: true,
    polling: false,
    revision: 0,
    transcript: { events: [], cursor: 0 },
    responseAttempts: new Set<string>(),
    draft,
    localCommand: {
      sessionId: 'session',
      executionNodeId: 'local',
      generation: 'generation',
      commandId: 'queued',
      text,
    },
  });
  return view;
}

const receipt = (submitted: boolean): NativeCommandReceipt => ({
  commandId: 'queued',
  generation: 'generation',
  state: 'failed',
  outcome: 'interrupted',
  submitted,
  accepted: submitted,
});

test('a queued message the session closed before taking goes back to the composer', async () => {
  const view = makeView(receipt(false), 'typed meanwhile');
  await view.poll();
  assert.equal(view.localCommand, undefined);
  assert.equal(view.draft, `${text}\n\ntyped meanwhile`);
});

test('a delivered message that failed stays out of the composer', async () => {
  const view = makeView(receipt(true), '');
  await view.poll();
  assert.equal(view.localCommand, undefined);
  assert.equal(view.draft, '');
});
