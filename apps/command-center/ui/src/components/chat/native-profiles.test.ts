import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  Methods,
  type NativeProfileInfo,
  type NativeProfileStatusResult,
} from '@farmslot/protocol';
import type {
  ResourceQuery,
  ResourceQueryError,
  ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import type { NativeProfileSelection } from './native-profiles.js';

type ListState = ResourceQueryState<{ profiles: NativeProfileInfo[] }>;
let listChanged: ((state: ListState) => void) | undefined;
type StatusState = ResourceQueryState<NativeProfileStatusResult>;
let statusChanged: ((state: StatusState) => void) | undefined;
const work: NativeProfileInfo = {
  id: 'work',
  runner: 'claude',
  directory: '/profiles/work',
  accountContextId: 'context',
  state: 'active',
};

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
    observeNativeResource: (query: ResourceQuery, changed: (state: ResourceQueryState) => void) => {
      if (query.method === Methods.NATIVE_PROFILE_LIST) listChanged = changed;
      else if (query.method === Methods.NATIVE_PROFILE_STATUS) statusChanged = changed;
      return () => undefined;
    },
  },
});

const { NativeProfiles } = await import('./native-profiles.js');

/** The private state and methods the test drives. */
interface Picker {
  selected: string;
  error: string | ResourceQueryError;
  render: InstanceType<typeof NativeProfiles>['render'];
  refresh(): Promise<void>;
  add(): Promise<void>;
  removeProfile(profile: NativeProfileInfo): Promise<void>;
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
    name: '',
    directory: '',
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
  assert.match(JSON.stringify(view.render()), /Native observation source unavailable/);
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
  // Removing the selected profile releases the default only when the removal ends.
  let removed!: () => void;
  Object.assign(view, {
    selected: 'work',
    api: { request: () => new Promise<void>((resolve) => (removed = resolve)) },
  });
  const removing = view.removeProfile(work);
  assert.equal(selections.at(-1)?.ready, false);
  removed();
  await removing;
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

test('profile status renders the refresh, blocked reason, and successful read', async () => {
  const { view, selections } = picker();
  view.selected = work.id;
  await view.refresh();
  listChanged!({ status: 'ready', data: { profiles: [work] } });
  for (const [message, title, role, retry] of [
    [
      'Native account profiles are refreshing for updated runner configuration. Retry shortly.',
      'Refreshing runner configuration',
      'status',
      'Check again',
    ],
    [
      'Native account profiles failed to resolve runner configuration: ambiguous pool settings for mini',
      'Runner configuration blocked',
      'alert',
      'Retry after fixing configuration',
    ],
    [
      'Execution node upgrade required for configured runner executables',
      'Runner configuration blocked',
      'alert',
      'Retry after fixing configuration',
    ],
  ]) {
    statusChanged!({
      status: 'error',
      error: {
        code: message.startsWith('Execution node')
          ? 'NATIVE_SOURCE_UNAVAILABLE'
          : 'NATIVE_PROFILES_UNAVAILABLE',
        message,
      },
    });
    const markup = JSON.stringify(view.render());
    assert.ok(markup.includes(title));
    assert.ok(markup.includes(message));
    assert.ok(markup.includes(retry));
    assert.ok(markup.includes('"' + role + '"'));
    assert.equal(selections.at(-1)?.ready, false);
  }
  statusChanged!({
    status: 'ready',
    data: {
      profile: work,
      loginCommand: 'claude auth login',
      account: {
        runner: 'claude',
        installed: true,
        login: 'authenticated',
        mode: 'subscription',
        identityQuality: 'unavailable',
        observedAt: '2026-11-28T00:00:00Z',
      },
    },
  });
  const markup = JSON.stringify(view.render());
  assert.match(markup, /authenticated · subscription/);
  assert.doesNotMatch(markup, /native-profile-read-issue|Retry after fixing configuration/);
  assert.equal(selections.at(-1)?.ready, true);
});
