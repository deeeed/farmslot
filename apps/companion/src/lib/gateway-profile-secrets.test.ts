import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { GatewayProfile } from './gateway-profiles';

const secrets = new Map<string, string>();
mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
mock.module('expo-secure-store', {
  namedExports: {
    getItemAsync: async (key: string) => secrets.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      secrets.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      secrets.delete(key);
    },
  },
});

test('preset seeding preserves an explicit login and restores only a missing preset', async () => {
  const { seedPresetGatewayProfileSecrets, writeGatewayProfileSecret, readGatewayProfileSecret } =
    await import('./gateway-profiles');
  const preset: GatewayProfile = {
    id: 'configured-gateway',
    name: 'Configured Gateway',
    url: 'ws://localhost:7801/ws',
    kind: 'custom',
    authMode: 'token',
    secretStorageKey: 'configured-secret',
    presetSecret: 'launcher-account-a',
  };
  await seedPresetGatewayProfileSecrets([preset]);
  assert.equal(await readGatewayProfileSecret(preset), 'launcher-account-a');
  await writeGatewayProfileSecret(preset, 'explicit-account-b');
  await seedPresetGatewayProfileSecrets([preset]);
  assert.equal(await readGatewayProfileSecret(preset), 'explicit-account-b');
  await writeGatewayProfileSecret(preset, '');
  assert.equal(await readGatewayProfileSecret(preset), null);
  await seedPresetGatewayProfileSecrets([preset]);
  assert.equal(await readGatewayProfileSecret(preset), 'launcher-account-a');
});
