import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

import { Events, Methods, type SlotStatus } from '@farmslot/protocol';

interface PendingCall {
  method: string;
  params: unknown;
  resolve(value: unknown): void;
}

const calls: PendingCall[] = [];
const listeners = new Set<() => void>();
const ownerListeners = new Set<() => void>();
const handlers = new Map<string, (payload: unknown) => void>();
let owner = 'first-owner';
let ready = true;
let fleet: { slots: SlotStatus[] } | null = null;
const gateway = {
  connectionState: 'connected',
  resourceConnectionId: 1,
  request(method: string, params: unknown) {
    return new Promise((resolve) => calls.push({ method, params, resolve }));
  },
  subscribe(event: string, handler: (payload: unknown) => void) {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
};
mock.module('../../gateway-client.js', { namedExports: { gateway } });
mock.module('../../resource-cache.js', {
  namedExports: { getResourceWorkspaceKey: () => owner },
});
mock.module('../../state.js', {
  namedExports: {
    getState: () => ({ fleet }),
    isFleetCurrent: () => ready,
    requireCurrentFleet: () => {
      if (!ready || !fleet) throw new Error('Wait for a current fleet read before acting.');
      return fleet;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onWorkspaceOwnerChange: (listener: () => void) => {
      ownerListeners.add(listener);
      return () => ownerListeners.delete(listener);
    },
  },
});
mock.module('../shared/resource-query-controller.js', {
  namedExports: {
    ResourceQueryController: class {
      belongsToWorkspace = false;
      state = { status: 'loading' };
      setQuery() {}
    },
  },
});
mock.module('../terminal/terminal-view.js', { namedExports: {} });
mock.module('../progress-tracker/progress-tracker.js', { namedExports: {} });
mock.module('../workspace/slot-workspace.js', { namedExports: {} });
const { SlotDetail } = await import('./slot-detail.js');

interface TestSlotDetail {
  slotId: string;
  _slot: SlotStatus | null;
  _pendingConfirm: string | null;
  _actionRunning: boolean;
  _actionOutput: string[];
  _repoPath: string;
  _prepare(): void;
  _runAction(method: string, params: Record<string, unknown>): Promise<void>;
  connectedCallback(): void;
  disconnectedCallback(): void;
  willUpdate(changed: Map<string, unknown>): void;
  enableUpdating(value: boolean): void;
  createRenderRoot(): object;
}
const panels: TestSlotDetail[] = [];
const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const slot = (id: string, runId = 'run-a') =>
  ({ slot: id, currentRunId: runId, taskFile: `task/${runId}`, machine: 'machine' }) as SlotStatus;
const notify = () => {
  for (const listener of listeners) listener();
};
function makePanel(): TestSlotDetail {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
  });
  fleet = { slots: [slot('slot-a'), slot('slot-b', 'run-b')] };
  const panel = new SlotDetail() as unknown as TestSlotDetail;
  panel.enableUpdating = () => undefined;
  // These lifecycle tests exercise controller ownership without a browser renderer.
  panel.createRenderRoot = () => ({});
  Object.defineProperty(panel, 'isConnected', { configurable: true, value: true });
  panel.slotId = 'slot-a';
  panel.connectedCallback();
  panels.push(panel);
  return panel;
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => {
  for (const panel of panels.splice(0)) {
    Object.defineProperty(panel, 'isConnected', { configurable: true, value: false });
    panel.disconnectedCallback();
  }
  calls.length = 0;
  listeners.clear();
  ownerListeners.clear();
  handlers.clear();
  owner = 'first-owner';
  ready = true;
  fleet = null;
  if (localStorageDescriptor)
    Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

test('fleet clearing and principal replacement retire copied slots and confirmations', () => {
  const panel = makePanel();
  panel._prepare();
  assert.equal(panel._pendingConfirm, 'prepare');
  fleet = null;
  notify();
  assert.equal(panel._slot, null);
  assert.equal(panel._pendingConfirm, null);

  fleet = { slots: [slot('slot-a')] };
  notify();
  panel._prepare();
  owner = 'replacement-owner';
  for (const listener of ownerListeners) listener();
  assert.equal(panel._slot, null);
  assert.equal(panel._pendingConfirm, null);
  assert.equal(panel._repoPath, '');
});

test('slot and run replacement require a new confirmation', async () => {
  const panel = makePanel();
  panel._prepare();
  panel.slotId = 'slot-b';
  panel.willUpdate(new Map([['slotId', 'slot-a']]));
  assert.equal(panel._pendingConfirm, null);
  panel._prepare();
  assert.equal(panel._pendingConfirm, 'prepare');
  assert.equal(calls.filter(({ method }) => method === Methods.SLOT_PREPARE).length, 0);

  fleet = { slots: [slot('slot-b', 'successor-run')] };
  notify();
  assert.equal(panel._pendingConfirm, null);
  panel._prepare();
  assert.equal(calls.filter(({ method }) => method === Methods.SLOT_PREPARE).length, 0);
  panel._prepare();
  const current = calls.find(({ method }) => method === Methods.SLOT_PREPARE)!;
  assert.equal(Reflect.get(current.params as object, 'slotId'), 'slot-b');
  current.resolve({ ok: true });
  await flush();
  assert.equal(panel._actionRunning, false);
});

test('a stale or removed slot cannot dispatch through an existing confirmation or direct call', async () => {
  const panel = makePanel();
  panel._prepare();
  ready = false;
  panel._prepare();
  assert.equal(panel._pendingConfirm, null);
  await panel._runAction(Methods.SLOT_PREPARE, { slotId: 'slot-a' });
  assert.equal(calls.filter(({ method }) => method === Methods.SLOT_PREPARE).length, 0);
  assert.match(panel._actionOutput.join(), /current fleet read/);

  ready = true;
  fleet = { slots: [] };
  await panel._runAction(Methods.SLOT_PREPARE, { slotId: 'slot-a' });
  assert.equal(calls.filter(({ method }) => method === Methods.SLOT_PREPARE).length, 0);
  assert.match(panel._actionOutput.join(), /no longer in the current fleet/);
});

test('old command replies, script output and pool reads cannot populate a successor slot', async () => {
  const panel = makePanel();
  const oldPool = calls.find(({ method }) => method === Methods.CONFIG_POOL)!;
  const oldAction = panel._runAction(Methods.SLOT_PREPARE, { slotId: 'slot-a' });
  const request = calls.find(({ method }) => method === Methods.SLOT_PREPARE)!;
  const requestId = Reflect.get(request.params as object, 'requestId');
  panel.slotId = 'slot-b';
  panel.willUpdate(new Map([['slotId', 'slot-a']]));
  oldPool.resolve({ pool: { slots: [{ id: 'slot-a', repo: '/old-private-path' }] } });
  handlers.get(Events.SCRIPT_OUTPUT)?.({ requestId, data: 'old-private-output' });
  request.resolve({ ok: true });
  await oldAction;
  await flush();
  assert.equal(panel._repoPath, '');
  assert.deepEqual(panel._actionOutput, []);
  assert.equal(panel._actionRunning, false);
  assert.equal(panel._slot?.slot, 'slot-b');
});
