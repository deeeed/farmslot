import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { NativeProfileReference, NativeSessionCatalogResult } from '@farmslot/protocol';

import type { DispatchNativeProfileSelection } from './dispatch-native-profile-model.js';

// The shared profile picker reads through the gateway; dispatch readiness is decided here.
mock.module('../chat/native-profiles.js', { namedExports: {} });

const { DispatchNativeProfiles } = await import('./dispatch-native-profiles.js');

/** The private state and lifecycle the test drives. */
interface Picker {
  profile?: NativeProfileReference;
  updated(changed: Map<PropertyKey, unknown>): void;
}

const catalog: NativeSessionCatalogResult = {
  runners: [],
  contexts: [
    {
      cwd: '/mini',
      slotId: 'mini-slot',
      project: 'farm',
      label: 'Mini',
      executionNodeId: 'mini',
      supportsProfiles: true,
    },
  ],
};

// Built from the prototype so no DOM or render cycle is needed.
function picker() {
  const selections: DispatchNativeProfileSelection[] = [];
  const view = Object.create(DispatchNativeProfiles.prototype) as Picker;
  Object.assign(view, {
    requestUpdate: () => undefined,
    dispatchEvent: (event: CustomEvent<DispatchNativeProfileSelection>) => {
      selections.push(event.detail);
      return true;
    },
    catalog,
    slotId: 'mini-slot',
    project: 'farm',
    runner: 'claude',
    refreshVersion: 0,
    disabled: false,
    chosenNode: '',
    pickerKey: '',
  });
  return { view, selections };
}

test('dispatch on the node default account does not wait for the profile list', () => {
  const { view, selections } = picker();
  view.updated(new Map([['runner', '']]));
  assert.equal(selections.at(-1)?.ready, true);
  assert.equal(selections.at(-1)?.executionNodeId, 'mini');
  view.updated(new Map([['refreshVersion', 0]]));
  assert.equal(selections.at(-1)?.ready, true);
  // A refresh still re-checks an explicitly selected profile.
  view.profile = {
    executionNodeId: 'mini',
    runner: 'claude',
    profileId: 'work',
    accountContextId: '957ee253-708e-45c4-bcbc-860df9f9123c',
  };
  view.updated(new Map([['refreshVersion', 1]]));
  assert.equal(selections.at(-1)?.ready, false);
});
