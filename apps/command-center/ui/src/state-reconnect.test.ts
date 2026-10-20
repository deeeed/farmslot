import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    parentRunId: null,
    lane: 'production',
    flowType: 'fix-bug',
    status: 'monitoring',
    project: 'farm',
    ticketOrPr: 'owner/repo#1',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'gpt-5.5', runner: 'codex' },
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  } as Run;
}

test('the workspace survives a gateway restart and clears only for another account', async (t) => {
  const keys = ['window', 'localStorage', 'location', 'document', 'history', 'WebSocket'] as const;
  const descriptors = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const store = new Map<string, string>();
  class Socket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    static instances: Socket[] = [];
    static holdAuth = false;
    static principalId = 'operator-a';
    readyState = 0;
    constructor() {
      super();
      Socket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    send(text: string) {
      const request = JSON.parse(text);
      // Bootstrap reads stay unanswered, so the test observes the workspace before a refetch.
      if (request.method !== 'auth.connect' || Socket.holdAuth) return;
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'res',
              id: request.id,
              ok: true,
              payload: {
                ok: true,
                capabilities: { workspaceAccess: 'farm' },
                principal: {
                  id: Socket.principalId,
                  subjectKind: 'service',
                  displayName: Socket.principalId,
                  roles: [{ role: 'admin', scope: { kind: 'global' } }],
                },
              },
            }),
          }),
        ),
      );
    }
    close() {
      this.readyState = 3;
    }
    gatewayRestart() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  const values = {
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
    location: { protocol: 'http:', host: 'localhost:1234', hash: '', hostname: 'localhost' },
    document: { cookie: '' },
    history: { replaceState: () => {} },
    WebSocket: Socket,
  };
  for (const key of keys)
    Object.defineProperty(globalThis, key, { configurable: true, value: values[key] });
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const { gateway } = await import('./gateway-client.js');
  const { getState, initState, isHydrating, onWorkspaceOwnerChange, updateRuns } =
    await import('./state.js');
  t.after(() => gateway.disconnect());
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  };

  initState();
  await gateway.setAuthCredentials({ token: 'operator-a-secret' });
  gateway.connect();
  await flush();
  assert.equal(gateway.connectionState, 'connected');
  updateRuns([makeRun()]);
  assert.equal(getState().runs.length, 1);
  let ownerChanges = 0;
  t.after(onWorkspaceOwnerChange(() => (ownerChanges += 1)));

  await t.test('a reconnect with the same principal keeps runs', async () => {
    // A gateway restart or network blip keeps the runs on screen, marked as stale.
    Socket.holdAuth = true;
    Socket.instances.at(-1)!.gatewayRestart();
    await flush();
    assert.notEqual(gateway.connectionState, 'connected');
    assert.deepEqual(
      getState().runs.map((run) => run.id),
      ['run-1'],
    );
    assert.equal(getState().workspaceAccess, 'farm');
    assert.equal(isHydrating(getState(), 'runs'), true);

    // Reconnecting as the same principal keeps them until the bootstrap replaces them.
    Socket.holdAuth = false;
    gateway.reconnect();
    await flush();
    assert.equal(gateway.connectionState, 'connected');
    assert.equal(gateway.authenticatedPrincipalId, 'operator-a');
    assert.deepEqual(
      getState().runs.map((run) => run.id),
      ['run-1'],
    );
    // The views stay mounted: nothing tears them down for the same account.
    assert.equal(ownerChanges, 0);
  });

  await t.test('a reconnect as a different principal clears', async () => {
    // Reconnecting as a different principal clears the previous account's workspace.
    Socket.principalId = 'operator-b';
    Socket.instances.at(-1)!.gatewayRestart();
    gateway.reconnect();
    await flush();
    assert.equal(gateway.connectionState, 'connected');
    assert.equal(gateway.authenticatedPrincipalId, 'operator-b');
    assert.deepEqual(getState().runs, []);
    assert.equal(ownerChanges, 1);
  });

  await t.test('a credential change on this client clears at once', async () => {
    // Changing credentials on this client clears at once, before any reconnect.
    updateRuns([makeRun({ id: 'run-2' })]);
    await gateway.setAuthCredentials({ token: 'operator-c-secret' });
    assert.deepEqual(getState().runs, []);
    assert.equal(getState().workspaceAccess, 'none');
    assert.equal(ownerChanges, 2);
  });
});
