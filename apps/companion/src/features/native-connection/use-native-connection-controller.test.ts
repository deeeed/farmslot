import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { AlertButton } from 'react-native';

import { buildGatewayPairingQrPayload } from '@farmslot/protocol';

import { forgetLastPairing } from '../../lib/gateway-pairing-claim';

const effects: Array<() => void | (() => void)> = [];
const refs: Array<{ current: unknown }> = [];
let refIndex = 0;
let cameraRequests = 0;
let buttons: AlertButton[] = [];
const dismissed: string[] = [];
const params: Array<{ payload: string }> = [];
const pairingPayload = JSON.stringify(
  buildGatewayPairingQrPayload(
    {
      url: 'ws://127.0.0.1:7788/ws',
      profileName: 'Pairing fixture',
      code: 'unused-fixture-code',
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
    [{ gatewayUrl: 'ws://127.0.0.1:7788/ws', profileName: 'Pairing fixture' }],
  ),
);
const profile = {
  id: 'existing',
  name: 'Saved gateway',
  kind: 'lan',
  url: 'ws://127.0.0.1:7788/ws',
};
const connection = {
  client: {},
  initializing: false,
  profiles: [profile],
  status: 'connected',
  workspaceAccess: 'farm',
  gatewayUrl: profile.url,
  connect: () => assert.fail('Cancel cannot reconnect'),
  saveProfile: () => assert.fail('Cancel cannot save a profile'),
  setActiveProfile: () => assert.fail('Cancel cannot replace the active profile'),
};

mock.module('react', {
  namedExports: {
    useEffect: (effect: () => void | (() => void)) => effects.push(effect),
    useRef: (current: unknown) => (refs[refIndex++] ??= { current }),
    useState: (value: unknown) => [value, () => undefined],
  },
});
mock.module('expo-router', {
  namedExports: {
    useRouter: () => ({
      dismissTo: (route: string) => dismissed.push(route),
      setParams: (value: { payload: string }) => params.push(value),
    }),
  },
});
mock.module('expo-camera', {
  namedExports: {
    useCameraPermissions: () => [
      null,
      async () => {
        cameraRequests++;
        return { granted: true };
      },
    ],
  },
});
mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
mock.module('expo-secure-store', {
  namedExports: {
    getItemAsync: async () => null,
    setItemAsync: () => assert.fail('Cancel cannot set credentials'),
    deleteItemAsync: () => assert.fail('Cancel cannot delete credentials'),
  },
});
mock.module('react-native', {
  namedExports: {
    Alert: {
      alert: (title: string, _message: string, actions: AlertButton[]) => {
        assert.equal(title, 'Pair with this gateway?');
        buttons = actions;
      },
    },
  },
});
mock.module('../../store/connection', {
  namedExports: {
    useConnectionStore: Object.assign(() => connection, { getState: () => connection }),
  },
});
mock.module('../settings/use-gateway-profile-controller', {
  namedExports: {
    pairingProfileTestState: () => assert.fail('Cancel cannot test addresses'),
    preferredReachablePairingResult: () => assert.fail('Cancel cannot select a pairing address'),
    startImportedPairingProfileTests: () => assert.fail('Cancel cannot test addresses'),
  },
});

let useNativeConnectionController: typeof import('./use-native-connection-controller').useNativeConnectionController;
test.before(async () => {
  ({ useNativeConnectionController } = await import('./use-native-connection-controller'));
});

function renderConnection(pairingLink?: string) {
  effects.length = 0;
  refIndex = 0;
  useNativeConnectionController({ pairingLink });
  effects.forEach((effect) => effect());
}

function cancelPairing() {
  forgetLastPairing();
  refs.length = 0;
  cameraRequests = 0;
  dismissed.length = 0;
  params.length = 0;
  buttons = [];
  renderConnection(pairingPayload);
  const cancel = buttons.find((action) => action.text === 'Cancel');
  assert.ok(cancel?.onPress);
  cancel.onPress();
}

test('cancel returns a paired profile to its connected workspace', () => {
  connection.status = 'connected';
  connection.profiles = [profile];
  cancelPairing();
  assert.deepEqual(dismissed, ['/(tabs)/runs']);
  assert.deepEqual(params, []);
});

test('cancel clears an unpaired setup link without opening the camera', () => {
  connection.status = 'disconnected';
  connection.profiles = [];
  cancelPairing();
  assert.deepEqual(params, [{ payload: '' }]);

  // The route turns an empty payload into an absent pairing link on the next render.
  renderConnection(params[0]?.payload || undefined);
  assert.deepEqual(dismissed, []);
  assert.equal(cameraRequests, 0);
});
