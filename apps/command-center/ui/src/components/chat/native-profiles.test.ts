import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { NativeProfileInfo } from '@farmslot/protocol';
import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

import type { NativeProfileSelection } from './native-profiles.js';

type ListState = ResourceQueryState<{ profiles: NativeProfileInfo[] }>;
let listChanged: ((state: ListState) => void) | undefined;

// The gateway client opens sockets; the picker's reads go through the resource cache.
mock.module('../../gateway-client.js', { namedExports: { gateway: {} } });
mock.module('../../resource-cache.js', {
  namedExports: {
    getResourceCache: () => undefined,
    getResourceNativeOwnerId: () => 'owner',
    subscribeResourceCache: () => () => undefined,
  },
});
mock.module('./native-session-observation.js', {
  namedExports: {
    observeNativeResource: (_query: unknown, changed: (state: ListState) => void) => {
      listChanged = changed;
      return () => undefined;
    },
  },
});

const { NativeProfiles } = await import('./native-profiles.js');

/** The private state and methods the test drives. */
interface Picker {
  selected: string;
  error: string;
  refresh(): Promise<void>;
  add(): Promise<void>;
}

// Built from the prototype so no DOM or render cycle is needed.
function picker() {
  const selections: NativeProfileSelection[] = [];
  const view = Object.create(NativeProfiles.prototype) as Picker;
  Object.defineProperty(view, 'isConnected', { value: true });
  Object.assign(view, {
    requestUpdate: () => undefined,
    dispatchEvent: (event: CustomEvent<NativeProfileSelection>) => {
      selections.push(event.detail);
      return true;
    },
    executionNodeId: 'mini',
    runner: 'claude',
    runnerOnly: false,
    profiles: [],
    selected: '',
    selectedContextId: '',
    revision: 0,
    listCurrent: false,
  });
  return { view, selections };
}

test('the node default account is ready while the profile list is loading or failing', async () => {
  const { view, selections } = picker();
  await view.refresh();
  listChanged!({ status: 'loading' });
  assert.deepEqual(selections.at(-1), { profile: undefined, ready: true, executionNodeId: 'mini' });
  listChanged!({
    status: 'error',
    error: { code: 'unavailable', message: 'Native observation source unavailable' },
  });
  assert.equal(selections.at(-1)?.ready, true);
  assert.equal(view.error, 'Native observation source unavailable');
  // An add in progress keeps the default account unready through stale or failed reads.
  let refuse!: (error: Error) => void;
  Object.assign(view, {
    name: 'work',
    directory: '',
    api: { request: () => new Promise((_resolve, reject) => (refuse = reject)) },
  });
  const adding = view.add();
  listChanged!({ status: 'stale' });
  assert.equal(selections.at(-1)?.ready, false);
  listChanged!({ status: 'error', error: { code: 'unavailable', message: 'Profile list failed' } });
  assert.equal(selections.at(-1)?.ready, false);
  refuse(new Error("This is the node's own login; no profile is needed"));
  await adding;
  assert.equal(selections.at(-1)?.ready, true);
  // An explicitly selected profile never falls back to the default account.
  view.selected = 'work';
  listChanged!({ status: 'loading' });
  assert.deepEqual(selections.at(-1), {
    profile: undefined,
    ready: false,
    executionNodeId: 'mini',
  });
});
