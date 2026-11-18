import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { AlertButton } from 'react-native';

import { buildGatewayPairingQrPayload } from '@farmslot/protocol';

import { forgetLastPairing } from '../../lib/gateway-pairing-claim';

const effects: Array<() => void | (() => void)> = [];
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
    useRef: (current: unknown) => ({ current }),
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
    useCameraPermissions: () => [null, () => assert.fail('Cancel cannot request a camera')],
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

function cancelPairing() {
  forgetLastPairing();
  effects.length = 0;
  dismissed.length = 0;
  params.length = 0;
  buttons = [];
  useNativeConnectionController({ pairingLink: pairingPayload });
  effects.forEach((effect) => effect());
  const cancel = buttons.find((action) => action.text === 'Cancel');
  assert.ok(cancel?.onPress);
  cancel.onPress();
}

test('cancel returns a paired profile to its connected workspace', () => {
  connection.status = 'connected';
  cancelPairing();
  assert.deepEqual(dismissed, ['/(tabs)/runs']);
  assert.deepEqual(params, []);
});

test('cancel consumes the request when the connection screen must stay open', () => {
  connection.status = 'disconnected';
  cancelPairing();
  assert.deepEqual(dismissed, []);
  assert.deepEqual(params, [{ payload: '' }]);
});
