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

test('preset seeding rotates launcher credentials and preserves explicit logins', async () => {
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
  // Main wrote a launcher secret without ownership metadata. Adopt that state.
  secrets.set('configured-secret', 'main-era-launcher');
  await seedPresetGatewayProfileSecrets([preset]);
  assert.equal(await readGatewayProfileSecret(preset), 'launcher-account-a');
  const rotated = { ...preset, presetSecret: 'rotated-launcher-account' };
  await seedPresetGatewayProfileSecrets([rotated]);
  assert.equal(await readGatewayProfileSecret(preset), 'rotated-launcher-account');
  await writeGatewayProfileSecret(preset, 'explicit-account-b');
  await seedPresetGatewayProfileSecrets([preset]);
  assert.equal(await readGatewayProfileSecret(preset), 'explicit-account-b');
  await seedPresetGatewayProfileSecrets([rotated]);
  assert.equal(await readGatewayProfileSecret(preset), 'explicit-account-b');
  // Saving the same value explicitly also takes ownership from the launcher.
  await writeGatewayProfileSecret(preset, rotated.presetSecret);
  await seedPresetGatewayProfileSecrets([preset]);
  assert.equal(await readGatewayProfileSecret(preset), 'rotated-launcher-account');
  await writeGatewayProfileSecret(preset, '');
  assert.equal(await readGatewayProfileSecret(preset), null);
  await seedPresetGatewayProfileSecrets([preset]);
  assert.equal(await readGatewayProfileSecret(preset), 'launcher-account-a');
});

test('Companion persists the shared expiry beside its secure login and clears it on explicit login/sign-out', async () => {
  const { rememberedSessionForProfile, writeGatewayProfileSecret } =
    await import('./gateway-profiles');
  const profile: GatewayProfile = {
    id: 'remembered',
    name: 'Remembered',
    url: 'ws://localhost:7801/ws',
    kind: 'custom',
    authMode: 'token',
    secretStorageKey: 'remembered-secret',
  };
  await writeGatewayProfileSecret(profile, 'fixture-token');
  const session = await rememberedSessionForProfile(profile, () => {});
  assert.ok(session);
  await session.recordSuccessfulUse();
  const saved = secrets.get('remembered-secret.expires-at');
  assert.ok(saved);
  const reloaded = await rememberedSessionForProfile(profile, () => {});
  assert.equal(reloaded?.expiresAt, Number(saved));
  await reloaded?.recordSuccessfulUse();
  assert.equal(secrets.get('remembered-secret.expires-at'), saved);
  secrets.set('remembered-secret.expires-at', String(Date.now() - 1));
  const expired = await rememberedSessionForProfile(profile, () => {});
  assert.throws(() => expired?.assertCurrent(), /expired/);
  await writeGatewayProfileSecret(profile, 'replacement-token');
  assert.equal(secrets.has('remembered-secret.expires-at'), false);
  await writeGatewayProfileSecret(profile, '');
  assert.equal(secrets.has('remembered-secret'), false);
});
