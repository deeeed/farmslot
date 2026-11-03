import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

import { Methods } from '@farmslot/protocol';

import { litText } from '../../testing/lit-text.js';

interface PendingCall {
  method: string;
  params: unknown;
  resolve(value: unknown): void;
}
const calls: PendingCall[] = [];
const listeners = new Set<() => void>();
let owner = 'owner-a';
const gateway = {
  connectionState: 'connected',
  resourceConnectionId: 1,
  request(method: string, params: unknown) {
    return new Promise((resolve) => {
      calls.push({ method, params, resolve });
    });
  },
};
mock.module('../../gateway-client.js', { namedExports: { gateway } });
mock.module('../../resource-cache.js', {
  namedExports: {
    getResourceWorkspaceKey: () => owner,
    subscribeResourceCache: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
});
interface QueryState {
  status: string;
  data?: { machine: string; devices: unknown[] };
  error?: { message: string };
}
/** Stands in for the shared cache binding; the controller's own tests cover owner changes. */
class FakeQueryController {
  state: QueryState = { status: 'loading' };
  query?: { method: string; params: unknown };
  retries = 0;
  constructor() {
    queries.push(this);
  }
  setQuery(query?: { method: string; params: unknown }) {
    this.query = query;
  }
  async retry() {
    this.retries++;
    return this.state;
  }
}
const queries: FakeQueryController[] = [];
mock.module('../shared/resource-query-controller.js', {
  namedExports: { ResourceQueryController: FakeQueryController },
});
// The wrapper calls this child through its public methods. No real browser is modified.
mock.module('./recipe-output-panel.js', { namedExports: {} });
const { RecipeRunnerControls } = await import('./recipe-runner-controls.js');
interface Child {
  running: boolean;
  rerun(): Promise<void>;
  cancel(): Promise<void>;
}
interface TestControls {
  runId: string;
  slotId: string;
  recipeRunId: string;
  run(): Promise<void>;
  running: boolean;
  render(): unknown;
  _copyCommand(): Promise<void>;
  willUpdate(changed: Map<string, unknown>): void;
  connectedCallback(): void;
  disconnectedCallback(): void;
  enableUpdating(value: boolean): void;
  querySelector(selector: string): Child | null;
  dispatchEvent(event: Event): boolean;
}
const panels: TestControls[] = [];
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const makeControls = (child: Child) => {
  const view = new RecipeRunnerControls() as unknown as TestControls;
  view.enableUpdating = () => undefined;
  view.querySelector = () => child;
  view.dispatchEvent = () => true;
  Object.defineProperty(view, 'isConnected', { configurable: true, value: true });
  Object.defineProperty(view, 'updateComplete', {
    configurable: true,
    value: Promise.resolve(true),
  });
  view.runId = 'run-a';
  view.slotId = 'slot-a';
  view.connectedCallback();
  panels.push(view);
  return view;
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => {
  for (const view of panels.splice(0)) {
    Object.defineProperty(view, 'isConnected', { configurable: true, value: false });
    view.disconnectedCallback();
  }
  calls.length = 0;
  queries.length = 0;
  listeners.clear();
  owner = 'owner-a';
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

test('a replay intent cannot turn into another run after waiting for rendering', async () => {
  let starts = 0;
  const view = makeControls({
    running: false,
    rerun: async () => {
      starts++;
    },
    cancel: async () => undefined,
  });
  let render!: () => void;
  Object.defineProperty(view, 'updateComplete', {
    configurable: true,
    value: new Promise<void>((resolve) => {
      render = resolve;
    }),
  });
  const start = view.run();
  view.runId = 'run-b';
  view.willUpdate(new Map([['runId', 'run-a']]));
  render();
  await start;
  assert.equal(starts, 0);
});

test('the previous replay cleanup cannot clear a successor running flag', async () => {
  let finish!: () => void;
  const first: Child = {
    running: false,
    rerun: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    cancel: async () => undefined,
  };
  const view = makeControls(first);
  const old = view.run();
  await flush();
  assert(view.running);
  view.runId = 'run-b';
  view.willUpdate(new Map([['runId', 'run-a']]));
  const next: Child = {
    running: true,
    rerun: async () => undefined,
    cancel: async () => undefined,
  };
  view.querySelector = () => next;
  await view.run();
  finish();
  await old;
  assert.equal(view.running, true);
});

test('a command reply from another owner never writes the clipboard or its feedback', async () => {
  const writes: string[] = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text: string) => {
          writes.push(text);
        },
      },
    },
  });
  const view = makeControls({
    running: false,
    rerun: async () => undefined,
    cancel: async () => undefined,
  });
  const old = view._copyCommand();
  const request = calls.find((call) => call.method === Methods.RECIPE_COMMAND)!;
  owner = 'owner-b';
  for (const listener of listeners) listener();
  request.resolve({ command: 'old-private-command' });
  await old;
  assert.deepEqual(writes, []);
  assert.doesNotMatch(litText(view.render()), /Copied|old-private-command/);
});

const idleChild: Child = {
  running: false,
  rerun: async () => undefined,
  cancel: async () => undefined,
};

test('the stored device list renders from the shared cache, never a direct gateway read', () => {
  const view = makeControls(idleChild);
  const [inventory] = queries;
  assert.equal(inventory.query?.method, Methods.RESOURCE_DEVICE_INVENTORY);
  assert.deepEqual(inventory.query?.params, { slotId: 'slot-a' });
  // A read that has no live updates still renders its stored list, with no notice about it.
  inventory.state = { status: 'unsupported', data: { machine: 'STORED_MACHINE', devices: [] } };
  const text = litText(view.render());
  assert.match(text, /STORED_MACHINE lists no simulator/);
  assert.doesNotMatch(text, /unavailable|unsupported/i);
  assert.equal(calls.filter((call) => call.method === Methods.RESOURCE_DEVICE_INVENTORY).length, 0);
});

test('a failed device read shows the typed fallback only when no list is stored', () => {
  const view = makeControls(idleChild);
  const [inventory] = queries;
  inventory.state = { status: 'error', error: { message: 'ssh refused' } };
  assert.match(litText(view.render()), /Device list unavailable \(ssh refused\)/);
  inventory.state = {
    status: 'stale',
    data: { machine: 'STORED_MACHINE', devices: [] },
    error: { message: 'ssh refused' },
  };
  assert.doesNotMatch(litText(view.render()), /Device list unavailable/);
});

test('the device query follows the slot', () => {
  const view = makeControls(idleChild);
  view.slotId = 'slot-b';
  view.willUpdate(new Map([['slotId', 'slot-a']]));
  assert.deepEqual(queries[0].query?.params, { slotId: 'slot-b' });
});
