import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import {
  type GatewayAuthConnectResult,
  type PersonSessionAuth,
  PersonSessionEndedError,
} from '@farmslot/protocol';

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
function verified(subjectKind: 'person' | 'service' | 'node'): GatewayAuthConnectResult {
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

test('a verified node credential retains the existing non-person storage path', async () => {
  const login = await api.prepareGatewayProfileLogin(profile, 'verified-node');
  await login.commitVerifiedCredential(verified('node'));
  assert.equal(await api.readGatewayProfileSecret(profile), 'verified-node');
  assert.equal(await api.readGatewayProfilePersonSession(profile), null);
});

test('deleting a profile that holds a person login signs it out on its gateway, then forgets it', async () => {
  // Not the running client's profile: nothing else holds this login.
  await signIn('a');
  let signedOutSession: string | undefined;
  const confirmed = await api.endGatewayProfilePersonLogin(
    profile,
    [profile],
    async (credentials) => {
      // As signOutGatewayDevice does once the gateway confirms the revoke.
      signedOutSession = ((await credentials.sessionStorage.load()) as PersonSessionAuth | null)
        ?.session.id;
      await credentials.sessionStorage.save(null);
    },
  );
  assert.equal(confirmed, true);
  assert.equal(signedOutSession, 'a'.repeat(32));
  assert.equal(await api.readGatewayProfilePersonSession(profile), null);
  // The delete's next step used to refuse a stored person login.
  await api.forgetGatewayProfileSecret(profile);
});

test('a profile whose gateway does not answer still loses its login here, and says so', async () => {
  await signIn('a');
  const confirmed = await api.endGatewayProfilePersonLogin(profile, [profile], async () => {
    throw new Error('Gateway did not connect and authenticate within 5000ms');
  });
  assert.equal(confirmed, false);
  assert.equal(await api.readGatewayProfilePersonSession(profile), null);
  await api.forgetGatewayProfileSecret(profile);

  // A session the gateway already ended needs no sign-out there.
  await signIn('b');
  assert.equal(
    await api.endGatewayProfilePersonLogin(profile, [profile], async () => {
      throw new PersonSessionEndedError();
    }),
    true,
  );
  assert.equal(await api.readGatewayProfilePersonSession(profile), null);
});

test('a sign-in another address of the same pairing still uses is only forgotten here', async () => {
  const tailnet: GatewayProfile = {
    ...profile,
    id: 'tailnet',
    name: 'Tailnet',
    url: 'ws://macwork.tail73dab7.ts.net:7801/ws',
    secretStorageKey: 'tailnet-secret',
  };
  // A pairing saves its one device sign-in on each address.
  await signIn('a');
  const tailnetLogin = await api.prepareGatewayProfileLogin(tailnet, 'fixture-person-input');
  await tailnetLogin.credentials.sessionStorage.save(saved('a'));
  await tailnetLogin.commitVerifiedCredential(verified('person'));
  assert.deepEqual(
    (await api.profilesSharingPersonLogin(profile, [profile, tailnet])).map(({ id }) => id),
    ['tailnet'],
  );

  let revoked = false;
  const confirmed = await api.endGatewayProfilePersonLogin(
    profile,
    [profile, tailnet],
    async () => {
      revoked = true;
    },
  );
  assert.equal(confirmed, true);
  assert.equal(revoked, false);
  assert.equal(await api.readGatewayProfilePersonSession(profile), null);
  assert.equal((await api.readGatewayProfilePersonSession(tailnet))?.session.id, 'a'.repeat(32));
  assert.deepEqual(await api.profilesSharingPersonLogin(tailnet, [profile, tailnet]), []);
});

test('a profile whose login cannot be read may share the session, so it is not revoked', async () => {
  await signIn('a');
  const tailnet: GatewayProfile = {
    ...profile,
    id: 'tailnet',
    name: 'Tailnet',
    url: 'ws://macwork.tail73dab7.ts.net:7801/ws',
    secretStorageKey: 'tailnet-secret',
  };
  const tailnetLogin = await api.prepareGatewayProfileLogin(tailnet, 'fixture-person-input');
  await tailnetLogin.credentials.sessionStorage.save(saved('a'));
  await tailnetLogin.commitVerifiedCredential(verified('person'));
  // Its saved login now belongs to another URL, so reading it fails.
  const unreadable = { ...tailnet, url: 'ws://moved.example:7801/ws' };
  await assert.rejects(api.readGatewayProfilePersonSession(unreadable));
  assert.deepEqual(
    (await api.profilesSharingPersonLogin(profile, [profile, unreadable])).map(({ id }) => id),
    ['tailnet'],
  );

  let revoked = false;
  const confirmed = await api.endGatewayProfilePersonLogin(
    profile,
    [profile, unreadable],
    async () => {
      revoked = true;
    },
  );
  assert.equal(confirmed, true);
  assert.equal(revoked, false);
  assert.equal(await api.readGatewayProfilePersonSession(profile), null);
  assert.equal((await api.readGatewayProfilePersonSession(tailnet))?.session.id, 'a'.repeat(32));
});

test('a sign-in saved to the profile while it is being deleted stays, and the delete stops', async () => {
  await signIn('a');
  let revoked: string | undefined;
  await assert.rejects(
    api.endGatewayProfilePersonLogin(profile, [profile], async (credentials) => {
      revoked = ((await credentials.sessionStorage.load()) as PersonSessionAuth | null)?.session.id;
      // A pairing saves a new sign-in to this profile while the revoke is in flight.
      const pairing = await api.prepareGatewayProfileLogin(
        profile,
        'fixture-person-input',
        undefined,
        { replacePersonLogin: true },
      );
      await pairing.credentials.sessionStorage.save(saved('b'));
      await pairing.commitVerifiedCredential(verified('person'));
      // The revoked client then clears its login: refused, the stored login changed.
      await credentials.sessionStorage.save(null);
    }),
    /signed in again during the delete/,
  );
  assert.equal(revoked, 'a'.repeat(32));
  assert.equal((await api.readGatewayProfilePersonSession(profile))?.session.id, 'b'.repeat(32));
  await assert.rejects(api.forgetGatewayProfileSecret(profile));
});
