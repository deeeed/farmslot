import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeProfileReference, NativeSessionCatalogResult } from '@farmslot/protocol';

import {
  dispatchNativeProfileKey,
  nativeDispatchNodeSlots,
  nativeDispatchProfileReason,
} from './dispatch-native-profile-model.js';

const context = { runner: 'claude', slotId: '', project: 'farm', refreshVersion: 1 };
const profile: NativeProfileReference = {
  executionNodeId: 'worker',
  runner: 'claude',
  profileId: 'work',
  accountContextId: '957ee253-708e-45c4-bcbc-860df9f9123c',
};
const catalog: NativeSessionCatalogResult = {
  runners: [],
  contexts: [
    {
      cwd: '/local',
      slotId: 'local-slot',
      project: 'farm',
      label: 'Local',
      supportsProfiles: true,
    },
    {
      cwd: '/worker',
      slotId: 'worker-slot',
      project: 'farm',
      label: 'Worker',
      executionNodeId: 'worker',
      supportsProfiles: true,
    },
    { cwd: '/old', slotId: 'old-slot', project: 'farm', label: 'Old', executionNodeId: 'old' },
    {
      cwd: '/other',
      slotId: 'other-slot',
      project: 'other',
      label: 'Other',
      executionNodeId: 'worker',
      supportsProfiles: true,
    },
  ],
};
const selection = {
  key: dispatchNativeProfileKey(context),
  executionNodeId: 'worker',
  profile,
  ready: true,
};
const input = { ...context, selection, catalog, catalogReady: true };

test('an explicit profile constrains automatic dispatch to that node and project', () => {
  assert.deepEqual(nativeDispatchNodeSlots(catalog, 'worker', 'farm'), ['worker-slot']);
  assert.deepEqual(nativeDispatchNodeSlots(catalog, 'local', 'farm'), ['local-slot']);
  assert.equal(nativeDispatchProfileReason(input), null);
  assert.match(
    nativeDispatchProfileReason({
      ...input,
      slotId: 'local-slot',
      selection: {
        ...selection,
        key: dispatchNativeProfileKey({ ...context, slotId: 'local-slot' }),
      },
    }) ?? '',
    /matching slot/,
  );
});

test('refresh, runner changes and unavailable or signed-out selections block both submissions', () => {
  assert.match(nativeDispatchProfileReason({ ...input, refreshVersion: 2 }) ?? '', /Checking/);
  assert.match(nativeDispatchProfileReason({ ...input, catalogReady: false }) ?? '', /Checking/);
  assert.match(
    nativeDispatchProfileReason({ ...input, selection: { ...selection, ready: false } }) ?? '',
    /login status/,
  );
  assert.match(
    nativeDispatchProfileReason({
      ...input,
      runner: 'codex',
      selection: { ...selection, key: dispatchNativeProfileKey({ ...context, runner: 'codex' }) },
    }) ?? '',
    /runner and node/,
  );
  assert.match(
    nativeDispatchProfileReason({ ...input, catalog: { runners: [], contexts: [] } }) ?? '',
    /matching slot/,
  );
});

test('old nodes keep default-account dispatch without advertising named profiles', () => {
  const old = { ...input, selection: { ...selection, executionNodeId: 'old', profile: undefined } };
  assert.equal(nativeDispatchProfileReason(old), null);
  assert.match(
    nativeDispatchProfileReason({
      ...old,
      selection: { ...old.selection, profile: { ...profile, executionNodeId: 'old' } },
    }) ?? '',
    /Profiles are unavailable/,
  );
  assert.equal(
    nativeDispatchProfileReason({ ...input, selection: { key: selection.key, ready: true } }),
    null,
  );
});
