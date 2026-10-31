import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  Methods,
  type NativeCommandReceipt,
  type NativeSessionReadResult,
} from '@farmslot/protocol';

// The view keeps its command and draft in localStorage, which node lacks.
const stored = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  },
});

// The workspace pane pulls CSS and Monaco that node can't load; the gateway client opens sockets.
mock.module('./native-workspace.js', { namedExports: {} });
mock.module('../../gateway-client.js', { namedExports: { gateway: {} } });

const { NativeSessionView } = await import('./native-session-view.js');

/** The private state and methods the tests drive. */
interface View {
  draft: string;
  localCommand?: { commandId: string; text: string };
  poll(): Promise<void>;
  editQueued(): Promise<void>;
  sessionKey(suffix: string): string;
}

const text = 'Then reply with only the word NEXT.';

function page(receipt: NativeCommandReceipt, generation = 'generation'): NativeSessionReadResult {
  return {
    session: {
      id: 'session',
      generation,
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
function makeView(receipt: NativeCommandReceipt, draft: string, generation?: string): View {
  const view = Object.create(NativeSessionView.prototype) as View;
  Object.defineProperty(view, 'isConnected', { value: true });
  Object.defineProperty(view, 'updateComplete', { value: Promise.resolve(true) });
  Object.assign(view, {
    requestUpdate: () => undefined,
    schedule: () => undefined,
    followTimeline: () => undefined,
    fixture: { read: async () => page(receipt, generation) },
    storageScope: 'fixture',
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
  stored.clear();
  stored.set(view.sessionKey('command:session'), JSON.stringify(view.localCommand));
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
  assert.equal(stored.get(view.sessionKey('draft:session')), view.draft);
  assert.equal(stored.has(view.sessionKey('command:session')), false);
});

test('a delivered message that failed stays out of the composer', async () => {
  const view = makeView(receipt(true), '');
  await view.poll();
  assert.equal(view.localCommand, undefined);
  assert.equal(view.draft, '');
  assert.equal(stored.has(view.sessionKey('draft:session')), false);
});

test('a queued message a resume carried into the new generation stays out of the composer', async () => {
  // The host may still deliver it: its receipt moved to the new generation, still queued.
  const carried = {
    ...receipt(false),
    generation: 'resumed',
    state: 'pending' as const,
    queued: true,
  };
  const view = makeView(carried, '', 'resumed');
  await view.poll();
  assert.equal(view.localCommand, undefined);
  assert.equal(view.draft, '');
});

test('Edit removes the queued message, and the composer gets its text back', async () => {
  const queued: NativeCommandReceipt = {
    commandId: 'queued',
    generation: 'generation',
    state: 'pending',
    queued: true,
    submitted: false,
    accepted: false,
  };
  const removed = {
    ...queued,
    queued: false,
    state: 'failed' as const,
    outcome: 'cancelled' as const,
  };
  const requests: Array<[string, unknown]> = [];
  const edit = async (cancelQueued: boolean) => {
    const view = makeView(removed, 'typed meanwhile');
    const session = page(queued).session;
    Object.assign(view, {
      session: {
        ...session,
        state: 'running',
        capabilities: { ...session.capabilities, cancelQueued },
      },
      receipts: [queued],
      caughtUp: true,
      busy: false,
      api: {
        request: async (method: string, params: unknown) => {
          requests.push([method, params]);
          return { receipt: removed };
        },
      },
    });
    await view.editQueued();
    return view;
  };
  // A session on an older host cannot remove it: no request, and the message stays.
  const older = await edit(false);
  assert.deepEqual(requests, []);
  assert.equal(older.localCommand?.commandId, 'queued');
  const view = await edit(true);
  assert.deepEqual(requests, [
    [
      Methods.NATIVE_SESSION_CANCEL,
      { sessionId: 'session', executionNodeId: 'local', commandId: 'queued' },
    ],
  ]);
  await view.poll();
  assert.equal(view.localCommand, undefined);
  assert.equal(view.draft, `${text}\n\ntyped meanwhile`);
});
