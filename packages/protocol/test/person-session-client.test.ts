import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PersonSessionChangedError,
  PersonSessionClient,
  PersonSessionEndedError,
} from '../src/person-session-client.js';
import {
  parsePersonSessionAuth,
  type PersonSessionAuth,
  type PersonSessionGrant,
} from '../src/rpc/auth.js';
import { Methods } from '../src/rpc/registry.js';

function fixture() {
  const clock = { now: Date.UTC(2026, 9, 16) };
  function grant(id = 'a'): PersonSessionGrant {
    return {
      session: {
        id: id.repeat(32),
        principalId: 'person',
        principalGeneration: 0,
        deviceName: 'Fixture device',
        deviceKind: 'cli',
        createdAt: new Date(clock.now).toISOString(),
        lastRefreshedAt: new Date(clock.now).toISOString(),
        refreshExpiresAt: new Date(clock.now + 30 * 86400_000).toISOString(),
        revokedAt: null,
      },
      refreshToken: `fsr_${id.repeat(32)}_${'r'.repeat(43)}`,
      accessToken: `fsa_${id.repeat(32)}_${'s'.repeat(43)}`,
      accessExpiresAt: new Date(clock.now + 3600_000).toISOString(),
    };
  }
  const initial = grant();
  const state: {
    saved: PersonSessionAuth | null;
    writes: Array<PersonSessionAuth | null>;
    calls: Array<{ method: string; accessToken?: string }>;
    respond: (method: string) => Promise<unknown>;
  } = {
    saved: { session: initial.session, refreshToken: initial.refreshToken },
    writes: [],
    calls: [],
    respond: async () => grant(),
  };
  const client = new PersonSessionClient({
    now: () => clock.now,
    storage: {
      load: async () => state.saved,
      save: async (saved) => {
        state.writes.push(saved);
        state.saved = saved;
      },
    },
    request: async (method, _params, accessToken) => {
      state.calls.push({ method, accessToken });
      return state.respond(method);
    },
  });
  return { client, clock, grant, state };
}

const device = { deviceName: 'Fixture device', deviceKind: 'cli' as const };

test('exchange persists refresh and metadata only, with access kept in memory', async () => {
  const { client, state, grant } = fixture();
  const token = await client.exchange({ ...device, credential: 'one-use-person-input' });
  assert.equal(token, grant().accessToken);
  assert.equal(client.currentAccessToken, token);
  assert.deepEqual(Object.keys(state.saved ?? {}).sort(), ['refreshToken', 'session']);
  const bytes = JSON.stringify(state.saved);
  assert.ok(!bytes.includes(token));
  assert.ok(!bytes.includes('one-use-person-input'));
  assert.equal(parsePersonSessionAuth(grant()), null);
  await client.dispose();
});

test('concurrent refresh is single-flight and access refreshes before the expiry boundary', async () => {
  const { client, state, clock, grant } = fixture();
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<unknown>();
  state.respond = async () => {
    started.resolve();
    return response.promise;
  };
  const requests = Promise.all(Array.from({ length: 8 }, () => client.accessToken(true)));
  await started.promise;
  assert.equal(state.calls.length, 1);
  response.resolve(grant());
  await requests;
  assert.equal(state.writes.length, 1);
  state.respond = async () => ({ ...grant(), accessToken: grant('b').accessToken });
  clock.now += 3600_000 - 30_001;
  await client.accessToken();
  assert.equal(state.calls.length, 1);
  clock.now += 1;
  assert.equal(await client.accessToken(), grant('b').accessToken);
  assert.equal(state.calls.length, 2);
  await client.dispose();
});

test('network failure retains saved authority; confirmed ended refresh clears it', async () => {
  const { client, state } = fixture();
  const saved = state.saved;
  state.respond = async () => {
    throw new Error('network unavailable');
  };
  await assert.rejects(client.accessToken(), /network unavailable/);
  assert.deepEqual(state.saved, saved);
  state.respond = async () => {
    throw Object.assign(new Error('ended'), { code: 'AUTH_SESSION_ENDED' });
  };
  await assert.rejects(client.accessToken(), PersonSessionEndedError);
  assert.equal(state.saved, null);
  assert.equal(client.currentAccessToken, null);
  await client.dispose();
});

test('sign-out requires acknowledged revocation before forgetting the device', async () => {
  const { client, state, grant, clock } = fixture();
  await client.accessToken();
  state.respond = async () => {
    throw new Error('network unavailable');
  };
  await assert.rejects(client.signOut(), /network unavailable/);
  assert.ok(state.saved);
  state.respond = async () => ({
    session: { ...grant().session, revokedAt: new Date(clock.now).toISOString() },
  });
  await client.signOut();
  assert.equal(state.saved, null);
  assert.equal(client.session, null);
  const revokes = state.calls.filter((call) => call.method === Methods.AUTH_SESSION_REVOKE);
  assert.equal(revokes.length, 2);
  assert.ok(revokes.every((call) => call.accessToken?.startsWith('fsa_')));
  await client.dispose();
});

test('a late refresh cannot overwrite a newer explicit sign-in', async () => {
  const { client, state, grant } = fixture();
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<unknown>();
  state.respond = async (method) => {
    if (method === Methods.AUTH_SESSION_REFRESH) {
      started.resolve();
      return response.promise;
    }
    return grant('b');
  };
  const oldRefresh = assert.rejects(client.accessToken(), PersonSessionChangedError);
  await started.promise;
  await client.exchange({ ...device, credential: 'replacement-person-input' });
  response.resolve(grant());
  await oldRefresh;
  assert.equal(state.saved?.session.id, grant('b').session.id);
  assert.equal(client.currentAccessToken, grant('b').accessToken);
  await client.dispose();
});

test('unknown or malformed server grants never enter durable storage', async () => {
  const { client, state, grant } = fixture();
  state.respond = async () => ({ ...grant(), accessExpiresAt: 'not a date' });
  await assert.rejects(client.exchange({ ...device, code: 'fixture-code' }), /invalid or expired/);
  assert.equal(state.writes.length, 0);
  assert.equal(client.currentAccessToken, null);
  await client.dispose();
});

test('idle refresh is scheduled before expiry and its timer is removed on disposal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, clock, state } = fixture();
  t.after(() => client.dispose());
  await client.accessToken();
  const refreshed = Promise.withResolvers<void>();
  const original = state.respond;
  state.respond = async (method) => {
    const value = await original(method);
    refreshed.resolve();
    return value;
  };
  client.startRefresh((error) => {
    throw error;
  });
  clock.now += 3570_000;
  t.mock.timers.tick(3570_000);
  await refreshed.promise;
  await client.accessToken(true);
  const count = state.calls.length;
  await client.dispose();
  t.mock.timers.tick(3600_000);
  assert.equal(state.calls.length, count);
});

test('a request retries an expired access response once through the same refresh authority', async () => {
  const { client, state } = fixture();
  let attempts = 0;
  const result = await client.withAccess(async () => {
    attempts += 1;
    if (attempts === 1)
      throw Object.assign(new Error('expired access'), { code: 'AUTH_SESSION_ENDED' });
    return 'accepted';
  });
  assert.equal(result, 'accepted');
  assert.equal(attempts, 2);
  assert.equal(
    state.calls.filter((call) => call.method === Methods.AUTH_SESSION_REFRESH).length,
    2,
  );
  await client.dispose();
});

test('a repeatedly refused request cannot start an unbounded refresh loop', async () => {
  const { client } = fixture();
  let attempts = 0;
  await assert.rejects(
    client.withAccess(async () => {
      attempts += 1;
      throw Object.assign(new Error('expired access'), { code: 'AUTH_SESSION_ENDED' });
    }),
    /expired access/,
  );
  assert.equal(attempts, 2);
  await client.dispose();
});

test('device clock offset cannot invalidate a grant with a valid gateway-issued lifetime', async () => {
  const { clock, state, grant } = fixture();
  const serverGrant = grant();
  clock.now += 2 * 3600_000;
  const client = new PersonSessionClient({
    now: () => clock.now,
    storage: {
      load: async () => state.saved,
      save: async (value) => {
        state.saved = value;
      },
    },
    request: async () => serverGrant,
  });
  assert.equal(await client.accessToken(), serverGrant.accessToken);
  assert.equal(client.currentAccessToken, serverGrant.accessToken);
  await client.dispose();
});

test('an access handoff refusal cannot erase a refresh grant the gateway just accepted', async () => {
  const { state, grant } = fixture();
  const client = new PersonSessionClient({
    storage: {
      load: async () => state.saved,
      save: async (value) => {
        state.saved = value;
      },
    },
    request: async () => grant(),
    onAccess: async () => {
      throw Object.assign(new Error('access handoff refused'), { code: 'AUTH_SESSION_ENDED' });
    },
  });
  await assert.rejects(client.accessToken(), /access handoff refused/);
  assert.ok(state.saved);
  assert.equal(state.saved.refreshToken, grant().refreshToken);
  await client.dispose();
});
