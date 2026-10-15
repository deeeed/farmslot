import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { GatewayAuthConnectResult, PersonSessionAuth } from '@farmslot/protocol';

import type { GatewayProfile } from './gateway-profiles';

const secrets = new Map<string, string>();
let failWrites = false;
mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
mock.module('expo-secure-store', {
  namedExports: {
    getItemAsync: async (key: string) => secrets.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      if (failWrites) throw new Error('Keychain unavailable');
      secrets.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      secrets.delete(key);
    },
  },
});
test.beforeEach(() => {
  secrets.clear();
  failWrites = false;
});
let api: typeof import('./gateway-profiles');
test.before(async () => {
  api = await import('./gateway-profiles');
});

const profile: GatewayProfile = {
  id: 'selected',
  name: 'Selected',
  url: 'ws://localhost:7801/ws',
  kind: 'custom',
  authMode: 'token',
  secretStorageKey: 'selected-secret',
};
function saved(id = 'a'): PersonSessionAuth {
  return {
    refreshToken: `fsr_${id.repeat(32)}_${'r'.repeat(43)}`,
    session: {
      id: id.repeat(32),
      principalId: 'person',
      principalGeneration: 0,
      deviceName: 'Companion',
      deviceKind: 'companion',
      createdAt: '2026-10-16T00:00:00.000Z',
      lastRefreshedAt: '2026-10-16T00:00:00.000Z',
      refreshExpiresAt: '2026-11-15T00:00:00.000Z',
      revokedAt: null,
    },
  };
}
function verified(subjectKind: 'person' | 'service'): GatewayAuthConnectResult {
  return {
    ok: true,
    clientKind: 'companion',
    authMode: 'token',
    authenticatedAt: Date.now(),
    principal: { id: subjectKind, displayName: subjectKind, subjectKind, roles: [] },
    capabilities: { httpBearerAuth: true, voiceInstructionFormatting: false },
  };
}
async function signIn(id = 'a') {
  const login = await api.prepareGatewayProfileLogin(profile, 'fixture-person-input');
  await login.credentials.sessionStorage.save(saved(id));
  await login.commitVerifiedCredential(verified('person'));
}

test('launcher rotation stays in memory and never overwrites an existing opaque service secret', async () => {
  secrets.set('selected-secret', 'old-service-value');
  const configured = { ...profile, presetSecret: 'launcher-a' };
  assert.equal(await api.readGatewayProfileSecret(configured), 'launcher-a');
  assert.equal(
    await api.readGatewayProfileSecret({ ...configured, presetSecret: 'launcher-b' }),
    'launcher-b',
  );
  assert.equal(secrets.get('selected-secret'), 'old-service-value');
  const login = await api.prepareGatewayProfileLogin(configured);
  await login.credentials.sessionStorage.save(null); // Typed person refusal of the in-memory launcher value.
  assert.equal(secrets.get('selected-secret'), 'old-service-value');
});

test('a verified service login is atomic and takes precedence over launcher configuration', async () => {
  const configured = { ...profile, presetSecret: 'launcher' };
  const login = await api.prepareGatewayProfileLogin(configured, 'verified-service');
  assert.equal(secrets.has('selected-secret'), false);
  await login.commitVerifiedCredential(verified('service'));
  assert.equal(await api.readGatewayProfileSecret(configured), 'verified-service');
  await api.forgetGatewayProfileSecret(configured);
  assert.equal(await api.readGatewayProfileSecret(configured), 'launcher');
});

test('person input and access tokens are never persisted while validation is pending', async () => {
  const login = await api.prepareGatewayProfileLogin(profile, 'fixture-person-input');
  await login.credentials.sessionStorage.save(saved());
  assert.equal(secrets.has('selected-secret'), false);
  await login.commitVerifiedCredential(verified('person'));
  const bytes = secrets.get('selected-secret') ?? '';
  assert.ok(!bytes.includes('fixture-person-input'));
  assert.ok(!bytes.includes('fsa_'));
  assert.equal(await api.readGatewayProfileSecret(profile), null);
  assert.deepEqual(await api.readGatewayProfilePersonSession(profile), saved());
});

test('a failed atomic secure save preserves the previous service login', async () => {
  secrets.set('selected-secret', 'previous-service');
  const login = await api.prepareGatewayProfileLogin(profile, 'fixture-person-input');
  await login.credentials.sessionStorage.save(saved());
  failWrites = true;
  await assert.rejects(login.commitVerifiedCredential(verified('person')), /Keychain unavailable/);
  assert.equal(secrets.get('selected-secret'), 'previous-service');
});

test('a confirmed ended person login cannot fall back to a configured launcher credential', async () => {
  await signIn();
  const configured = { ...profile, presetSecret: 'old-launcher-person-input' };
  const login = await api.prepareGatewayProfileLogin(configured);
  await login.credentials.sessionStorage.save(null);
  await api.forgetGatewayProfileSecret(configured);
  assert.equal(await api.readGatewayProfileSecret(configured), null);
  assert.equal(await api.readGatewayProfilePersonSession(configured), null);
  assert.equal(
    (await api.prepareGatewayProfileLogin(configured)).credentials.personSessionRequired,
    true,
  );
});

test('a late refresh cannot overwrite another explicit device login', async () => {
  await signIn();
  const old = await api.prepareGatewayProfileLogin(profile);
  const ending = await api.prepareGatewayProfileLogin(profile);
  await ending.credentials.sessionStorage.save(null);
  await signIn('b');
  await assert.rejects(old.credentials.sessionStorage.save(saved()), /sign-in changed/);
  assert.equal((await api.readGatewayProfilePersonSession(profile))?.session.id, 'b'.repeat(32));
});

test('gateway scope mismatch refuses without deleting the saved login', async () => {
  await signIn();
  const bytes = secrets.get('selected-secret');
  await assert.rejects(
    api.prepareGatewayProfileLogin({ ...profile, url: 'ws://another.example/ws' }),
    /another gateway/,
  );
  assert.equal(secrets.get('selected-secret'), bytes);
});

test('legacy opaque values remain untouched until an actual gateway identifies them', async () => {
  const opaque = '{"opaque":"legacy-value"}';
  secrets.set('selected-secret', opaque);
  assert.equal(await api.readGatewayProfileSecret(profile), opaque);
  await api.prepareGatewayProfileLogin(profile);
  assert.equal(secrets.get('selected-secret'), opaque);
});

test('the secure writer rejects a complete access grant', async () => {
  const login = await api.prepareGatewayProfileLogin(profile, 'fixture-person-input');
  const rejected = login.credentials.sessionStorage.save({
    ...saved(),
    // @ts-expect-error Access tokens must never be given to persistent session storage.
    accessToken: `fsa_${'a'.repeat(32)}_${'s'.repeat(43)}`,
  });
  await assert.rejects(rejected, /Invalid device session storage/);
  assert.equal(secrets.has('selected-secret'), false);
});
