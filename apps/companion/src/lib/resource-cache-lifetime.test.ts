import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { createMemoryResourceStore } from '@farmslot/protocol/client-cache';

const GATEWAY = 'ws://lifetime.invalid/';

class FakeClient {
  readonly connectionState = 'disconnected';
  readonly connectionGeneration = 1;
  readonly resourceConnectionReason = undefined;
  readonly authenticatedConnection = undefined;
  readonly gatewayUrl = GATEWAY;
  requestResource() {
    return new Promise<never>(() => {});
  }
  subscribe() {
    return () => {};
  }
  onConnectionChange() {
    return () => {};
  }
  reconnect() {}
}

let state = {
  client: new FakeClient(),
  gatewayUrl: GATEWAY,
  signedOut: false,
  activeProfileId: 'profile-a',
  activeProfileHttpAuthHeaders: {},
};
const storeListeners = new Set<() => void>();
function setState(next: Partial<typeof state>) {
  state = { ...state, ...next };
  for (const listener of [...storeListeners]) listener();
}
mock.module('../store/connection', {
  namedExports: {
    useConnectionStore: {
      getState: () => state,
      subscribe(listener: () => void) {
        storeListeners.add(listener);
        return () => storeListeners.delete(listener);
      },
    },
  },
});
mock.module('react-native', {
  namedExports: {
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  },
});
mock.module('@react-native-async-storage/async-storage', {
  defaultExport: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
});
// Gate media files stay out of this test: none are held.
mock.module('expo-file-system/legacy', {
  namedExports: {
    cacheDirectory: 'file:///cache/',
    getInfoAsync: async () => ({ exists: false }),
    makeDirectoryAsync: async () => {},
    deleteAsync: async () => {},
  },
});
mock.module('@farmslot/local-store/native', {
  namedExports: { createNativeSqliteResourceStore: async () => createMemoryResourceStore() },
});
mock.module('./content-prefetch', {
  namedExports: { startContentPrefetch: () => () => {} },
});

test('an app root mounted before the previous one unmounts keeps the resource cache', async () => {
  const { getResourceCache, initializeNativeResourceCache } = await import('./resource-cache');
  // A package update relaunches the activity over itself: the new root mounts, then the old one
  // unmounts in the same JS runtime.
  const departing = initializeNativeResourceCache();
  const staying = initializeNativeResourceCache();
  const cache = getResourceCache();
  assert.ok(cache);

  departing();
  departing();
  assert.equal(getResourceCache(), cache, 'the root that stays still holds the cache');

  // It still follows the connection store: signing out closes the cache, signing in opens one.
  setState({ signedOut: true });
  assert.equal(getResourceCache(), undefined);
  setState({ signedOut: false });
  assert.ok(getResourceCache());

  staying();
  assert.equal(getResourceCache(), undefined, 'the last root to leave closes the cache');
});
