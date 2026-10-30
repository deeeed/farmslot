import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import {
  type GatewayAuthConnectResult,
  type PersonSessionAuth,
  PersonSessionChangedError,
  PersonSessionClient,
  PersonSessionEndedError,
} from '@farmslot/protocol';

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
test.beforeEach(() => secrets.clear());
let profiles: typeof import('./gateway-profiles');
let save: typeof import('./gateway-pairing-save');
test.before(async () => {
  profiles = await import('./gateway-profiles');
  save = await import('./gateway-pairing-save');
});

const lan: GatewayProfile = {
  id: 'paired-ws-192-168-128-52-7801-ws',
  name: 'macwork (LAN)',
  url: 'ws://192.168.128.52:7801/ws',
  kind: 'lan',
  authMode: 'token',
  secretStorageKey: 'lan-login',
};
const tailnet: GatewayProfile = {
  ...lan,
  id: 'paired-ws-macwork-tail73dab7-ts-net-7801-ws',
  name: 'macwork (Tailscale)',
  url: 'ws://macwork.tail73dab7.ts.net:7801/ws',
  kind: 'tailnet',
  secretStorageKey: 'tailnet-login',
};
function session(id: string): PersonSessionAuth {
  return {
    refreshToken: `fsr_${id.repeat(32)}_${'r'.repeat(43)}`,
    session: {
      id: id.repeat(32),
      principalId: 'arthur',
      principalGeneration: 1,
      deviceName: 'Mobile Companion',
      deviceKind: 'companion',
      createdAt: '2026-10-16T00:00:00.000Z',
      lastRefreshedAt: '2026-10-16T00:00:00.000Z',
      refreshExpiresAt: '2026-11-15T00:00:00.000Z',
      revokedAt: null,
    },
  };
}
const verified: GatewayAuthConnectResult = {
  ok: true,
  clientKind: 'companion',
  authMode: 'token',
  authenticatedAt: 1,
  capabilities: { httpBearerAuth: true, voiceInstructionFormatting: true },
  principal: {
    id: 'arthur',
    generation: 1,
    displayName: 'Arthur',
    subjectKind: 'person',
    roles: [],
  },
} as GatewayAuthConnectResult;

async function signIn(
  profile: GatewayProfile,
  auth: PersonSessionAuth,
  onReplace?: (previous: string | null) => void,
) {
  const login = await profiles.prepareGatewayProfileLogin(profile, undefined, auth, {
    replacePersonLogin: true,
    onReplace,
  });
  await login.credentials.sessionStorage.save(auth);
  await login.commitVerifiedCredential(verified);
  return login;
}

test('pairing again replaces the person login saved for that gateway', async () => {
  await signIn(lan, session('a'));
  const paired = session('b');
  await save.savePairedProfiles(
    [
      { profile: lan, personSession: paired },
      { profile: tailnet, personSession: paired },
    ],
    async ({ profile }, onReplace) => {
      await signIn(profile, paired, onReplace);
    },
  );
  assert.equal((await profiles.readGatewayProfilePersonSession(lan))?.session.id, 'b'.repeat(32));
  assert.equal(
    (await profiles.readGatewayProfilePersonSession(tailnet))?.session.id,
    'b'.repeat(32),
  );
});

test('a pairing that fails part way puts back the logins it replaced', async () => {
  await signIn(lan, session('a'));
  await signIn(tailnet, session('d'));
  const paired = session('b');
  await assert.rejects(
    save.savePairedProfiles(
      [
        { profile: lan, personSession: paired },
        { profile: tailnet, personSession: paired },
      ],
      async ({ profile }, onReplace) => {
        if (profile === tailnet) throw new Error('Keychain unavailable');
        await signIn(profile, paired, onReplace);
      },
    ),
    /Keychain unavailable/u,
  );
  assert.equal((await profiles.readGatewayProfilePersonSession(lan))?.session.id, 'a'.repeat(32));
  assert.equal(
    (await profiles.readGatewayProfilePersonSession(tailnet))?.session.id,
    'd'.repeat(32),
    'a profile the pairing never wrote keeps its login',
  );
});

test('a rollback keeps a login someone else saved after the pairing wrote its own', async () => {
  await signIn(lan, session('a'));
  const paired = session('b');
  await assert.rejects(
    save.savePairedProfiles(
      [
        { profile: lan, personSession: paired },
        { profile: tailnet, personSession: paired },
      ],
      async ({ profile }, onReplace) => {
        if (profile === tailnet) {
          await signIn(lan, session('c'));
          throw new Error('Keychain unavailable');
        }
        await signIn(profile, paired, onReplace);
      },
    ),
    /Keychain unavailable/u,
  );
  assert.equal((await profiles.readGatewayProfilePersonSession(lan))?.session.id, 'c'.repeat(32));
});

test('a rollback still runs behind a refresh the replaced login could not save', async () => {
  const running = await signIn(lan, session('a'));
  const paired = session('b');
  let refresh: Promise<void> | undefined;
  await assert.rejects(
    save.savePairedProfiles(
      [
        { profile: lan, personSession: paired },
        { profile: tailnet, personSession: paired },
      ],
      async ({ profile }, onReplace) => {
        if (profile === tailnet) {
          // The running client saves a refresh of login A just as the pairing's next write fails.
          refresh = running.credentials.sessionStorage.save(session('a'));
          throw new Error('Profile list write failed');
        }
        await signIn(profile, paired, onReplace);
      },
    ),
    /Profile list write failed/u,
  );
  assert.ok(refresh);
  await assert.rejects(refresh, PersonSessionChangedError);
  assert.equal((await profiles.readGatewayProfilePersonSession(lan))?.session.id, 'a'.repeat(32));
});

const reachable = { profile: lan, reachable: true };

function probeThatSeesSessionEnd(entry: { personSession?: PersonSessionAuth }) {
  return async () => {
    const { sessionStorage } = save.pairingProbeCredentials(entry);
    assert.ok(sessionStorage);
    const probe = new PersonSessionClient({
      storage: sessionStorage,
      request: async () => {
        throw Object.assign(new Error('ended'), { code: 'AUTH_SESSION_ENDED' });
      },
    });
    await assert.rejects(probe.accessToken(true), PersonSessionEndedError);
    return null;
  };
}

test('a pairing whose addresses never answer saves nothing', async () => {
  await signIn(lan, session('a'));
  const entry = { profile: lan, personSession: session('b') };
  const saved: string[] = [];
  await assert.rejects(
    save.keepPairing([entry], {
      probe: probeThatSeesSessionEnd(entry),
      save: async ({ profile }) => {
        saved.push(profile.id);
      },
      activate: async () => undefined,
    }),
    /None of the paired addresses answered, so nothing was saved/u,
  );
  assert.deepEqual(saved, []);
  assert.equal((await profiles.readGatewayProfilePersonSession(lan))?.session.id, 'a'.repeat(32));
});

test('a pairing saves only after an address answers and keeps its logins if switching fails', async () => {
  await signIn(lan, session('a'));
  const paired = session('b');
  const steps: string[] = [];
  await assert.rejects(
    save.keepPairing(
      [
        { profile: lan, personSession: paired },
        { profile: tailnet, personSession: paired },
      ],
      {
        probe: async () => {
          steps.push('probe');
          return reachable;
        },
        save: async ({ profile }, onReplace) => {
          steps.push(`save ${profile.kind}`);
          await signIn(profile, paired, onReplace);
        },
        activate: async ({ profile }) => {
          steps.push(`activate ${profile.kind}`);
          throw new Error('Could not switch');
        },
      },
    ),
    /Could not switch/u,
  );
  assert.deepEqual(steps, ['probe', 'save lan', 'save tailnet', 'activate lan']);
  assert.equal((await profiles.readGatewayProfilePersonSession(lan))?.session.id, 'b'.repeat(32));
});
