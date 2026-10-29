import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

import { Events, Methods } from '@farmslot/protocol';

import { litText } from '../../testing/lit-text.js';

interface PendingCall {
  method: string;
  params: unknown;
  resolve(value: unknown): void;
  reject(error: Error): void;
}
const calls: PendingCall[] = [];
const handlers = new Map<string, Set<(payload: unknown) => void>>();
const ownerListeners = new Set<() => void>();
const connectionListeners = new Set<() => void>();
let owner = 'first-owner';
const gateway = {
  connectionState: 'connected',
  resourceConnectionId: 1,
  request(method: string, params: unknown) {
    return new Promise((resolve, reject) => {
      calls.push({ method, params, resolve, reject });
    });
  },
  subscribe<T>(event: string, handler: (payload: T) => void) {
    const listeners = handlers.get(event) ?? new Set<(payload: unknown) => void>();
    const receive = (payload: unknown) => handler(payload as T);
    listeners.add(receive);
    handlers.set(event, listeners);
    return () => listeners.delete(receive);
  },
  onConnectionChange(listener: () => void) {
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
  },
};
mock.module('../../gateway-client.js', { namedExports: { gateway } });
mock.module('../../resource-cache.js', {
  namedExports: {
    getResourceWorkspaceKey: () => owner,
    subscribeResourceCache: (listener: () => void) => {
      ownerListeners.add(listener);
      return () => ownerListeners.delete(listener);
    },
  },
});
const { RecipeOutputPanel } = await import('./recipe-output-panel.js');
interface TestPanel {
  runId: string;
  slotId: string;
  recipeRunId: string;
  recipeArtifactPath: string;
  disabled: boolean;
  beforeRun?: () => void;
  rerun(): Promise<void>;
  cancel(): Promise<void>;
  render(): unknown;
  connectedCallback(): void;
  disconnectedCallback(): void;
  willUpdate(changed: Map<string, unknown>): void;
  enableUpdating(value: boolean): void;
  querySelector(selector: string): HTMLElement | null;
  dispatchEvent(event: Event): boolean;
  running: boolean;
}
const panels: TestPanel[] = [];
const makePanel = () => {
  const panel = new RecipeOutputPanel() as unknown as TestPanel;
  panel.enableUpdating = () => undefined;
  panel.querySelector = () => null;
  Object.defineProperty(panel, 'isConnected', { configurable: true, value: true });
  const events: Event[] = [];
  panel.dispatchEvent = (event) => {
    events.push(event);
    return true;
  };
  panel.runId = 'run-a';
  panel.slotId = 'slot-a';
  panel.connectedCallback();
  panels.push(panel);
  return { panel, events };
};
const emit = (event: string, payload: unknown) => {
  for (const listener of [...(handlers.get(event) ?? [])]) listener(payload);
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => {
  for (const panel of panels.splice(0)) {
    Object.defineProperty(panel, 'isConnected', { configurable: true, value: false });
    panel.disconnectedCallback();
  }
  calls.length = 0;
  handlers.clear();
  ownerListeners.clear();
  connectionListeners.clear();
  owner = 'first-owner';
  gateway.connectionState = 'connected';
  gateway.resourceConnectionId = 1;
});

test('a start reply cannot replace another run or clear its pending start', async () => {
  const { panel } = makePanel();
  const first = panel.rerun();
  assert.equal(calls.length, 1);
  panel.runId = 'run-b';
  panel.slotId = 'slot-b';
  panel.willUpdate(
    new Map([
      ['runId', 'run-a'],
      ['slotId', 'slot-a'],
    ]),
  );
  const second = panel.rerun();
  assert.equal(calls.length, 2, 'The new view is not locked by its predecessor');
  calls[0].resolve({ requestId: 'old-job' });
  await first;
  assert.doesNotMatch(litText(panel.render()), /old-job|accepted/);
  calls[1].resolve({ requestId: 'new-job' });
  await second;
  emit(Events.SCRIPT_OUTPUT, { requestId: 'old-job', data: 'OLD OUTPUT' });
  emit(Events.SCRIPT_OUTPUT, { requestId: 'new-job', data: 'CURRENT OUTPUT' });
  assert.match(litText(panel.render()), /CURRENT OUTPUT/);
  assert.doesNotMatch(litText(panel.render()), /OLD OUTPUT/);
});

test('principal replacement drops output and late completions without replaying the command', async () => {
  const { panel, events } = makePanel();
  const start = panel.rerun();
  calls[0].resolve({ requestId: 'private-job' });
  await start;
  emit(Events.SCRIPT_OUTPUT, { requestId: 'private-job', data: 'FIRST OWNER OUTPUT' });
  assert.match(litText(panel.render()), /FIRST OWNER OUTPUT/);
  owner = 'replacement-owner';
  for (const listener of ownerListeners) listener();
  emit(Events.SCRIPT_COMPLETE, {
    requestId: 'private-job',
    exitCode: 0,
    artifactRoot: 'old-private-root',
  });
  assert.equal(litText(panel.render()), '');
  assert.equal(panel.running, false);
  assert.equal(events.filter((event) => event.type === 'recipe-complete').length, 0);
  assert.equal(calls.length, 1);
});

test('ordinary readiness changes retain the admitted recipe output and its request identity', async () => {
  const { panel } = makePanel();
  const start = panel.rerun();
  panel.disabled = true;
  calls[0].resolve({ requestId: 'admitted-job' });
  await start;
  emit(Events.SCRIPT_OUTPUT, { requestId: 'admitted-job', data: 'Still the same job' });
  assert.match(litText(panel.render()), /Still the same job/);
  assert.equal(panel.running, true);
  const cancel = panel.cancel();
  assert.deepEqual(calls[1].params, { slotId: 'slot-a', requestId: 'admitted-job' });
  calls[1].resolve({ cancelled: true });
  await cancel;
});

test('a late Cancel reply belongs to its original target and cannot change a successor output', async () => {
  const { panel } = makePanel();
  const start = panel.rerun();
  calls[0].resolve({ requestId: 'job-a' });
  await start;
  const cancel = panel.cancel();
  assert.equal(calls[1].method, Methods.RECIPE_CANCEL);
  panel.recipeRunId = 'another-invocation';
  panel.willUpdate(new Map([['recipeRunId', '']]));
  const next = panel.rerun();
  calls[2].resolve({ requestId: 'job-b' });
  await next;
  calls[1].resolve({ cancelled: false, reason: 'OLD CANCELLATION' });
  await cancel;
  assert.doesNotMatch(litText(panel.render()), /OLD CANCELLATION/);
  emit(Events.SCRIPT_OUTPUT, { requestId: 'job-b', data: 'New invocation' });
  assert.match(litText(panel.render()), /New invocation/);
});

test('connection loss retires callbacks, reports uncertain delivery and never resubmits', async () => {
  const { panel } = makePanel();
  const start = panel.rerun();
  gateway.connectionState = 'disconnected';
  for (const listener of connectionListeners) listener();
  calls[0].resolve({ requestId: 'late-old-connection' });
  await start;
  assert.equal(panel.running, false);
  assert.match(litText(panel.render()), /disconnected|connection changed/i);
  assert.doesNotMatch(litText(panel.render()), /late-old-connection/);
  gateway.connectionState = 'connected';
  gateway.resourceConnectionId = 2;
  for (const listener of connectionListeners) listener();
  await flush();
  assert.equal(calls.length, 1);
});

test('admission changing before the wire refuses the start and clears its busy state', async () => {
  const { panel } = makePanel();
  panel.beforeRun = () => {
    panel.disabled = true;
  };
  await panel.rerun();
  assert.equal(calls.length, 0);
  assert.equal(panel.running, false);
  assert.match(litText(panel.render()), /no longer ready/);
});
