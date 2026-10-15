// Manual cross-client contract proof. Uses only isolated fixture identities.
import assert from 'node:assert/strict';
import test from 'node:test';

import { testGatewayConnection as testCompanionGatewayConnection } from '../../../apps/companion/src/lib/gateway-connection-test.js';
import { exchangeGatewayPairingQr } from '../../../apps/companion/src/lib/gateway-pairing-exchange.js';
import {
  hasAuthErrorCode,
  Methods,
  type PairingCreateResult,
  type PersonSessionAuth,
  type PersonSessionGrant,
} from '../../../packages/protocol/src/index.js';
import { rpcFixture } from '../src/security/person-sessions.test.js';

test('the Companion transport exchanges, renews and clears person authority through the public gateway', async (t) => {
  const f = await rpcFixture(t);
  let saved: PersonSessionAuth | null = null;
  const sessionStorage = {
    load: async () => saved,
    save: async (value: PersonSessionAuth | null) => {
      saved = value;
    },
  };
  const first = await testCompanionGatewayConnection(f.url, {
    token: f.credential.secret,
    explicitPersonSignIn: true,
    sessionStorage,
  });
  assert.equal(first.principal?.id, f.person.id);
  assert.equal(first.gatewayPingSupported, false);
  const administrator = await testCompanionGatewayConnection(f.url, {
    token: f.adminCredential.secret,
  });
  assert.equal(administrator.gatewayPingSupported, true);
  assert.ok(saved);
  const snapshot = await sessionStorage.load();
  assert.ok(snapshot);
  assert.ok(!JSON.stringify(snapshot).includes('fsa_'));
  assert.ok(!JSON.stringify(snapshot).includes(f.credential.secret));
  const second = await testCompanionGatewayConnection(f.url, {
    sessionStorage,
    personSessionRequired: true,
  });
  assert.equal(second.principal?.id, f.person.id);
  const access = await f.client().call<PersonSessionGrant>(Methods.AUTH_SESSION_REFRESH, {
    refreshToken: snapshot.refreshToken,
  });
  await f
    .client(access.accessToken)
    .call(Methods.AUTH_SESSION_REVOKE, { sessionId: access.session.id });
  await assert.rejects(
    testCompanionGatewayConnection(f.url, { sessionStorage, personSessionRequired: true }),
    (error: unknown) => hasAuthErrorCode(error, 'AUTH_SESSION_ENDED'),
  );
  assert.equal(await sessionStorage.load(), null);
});

test('Companion person pairing exchanges one invitation across its declared profile aliases', async (t) => {
  const f = await rpcFixture(t);
  const pairing = await f
    .client(f.adminCredential.secret)
    .call<PairingCreateResult>(Methods.PAIRING_CREATE, {
      gatewayUrl: f.url,
      authority: { kind: 'existing-principal', principalId: f.person.id },
    });
  const profiles = await exchangeGatewayPairingQr({
    type: 'farmslot.gateway-pairing.v1',
    profiles: [
      { url: f.url, code: pairing.code, profileName: 'Primary' },
      { url: f.url.replace('127.0.0.1', 'localhost'), code: pairing.code, profileName: 'Alias' },
    ],
  });
  assert.equal(profiles.length, 2);
  assert.ok(profiles[0].personSession);
  assert.equal(profiles[0].personSession.refreshToken, profiles[1].personSession?.refreshToken);
  assert.equal(profiles[0].secret, undefined);
  assert.equal(profiles[0].verification?.principal?.id, f.person.id);
  assert.equal(profiles[1].verification?.principal?.id, f.person.id);
  assert.ok(!JSON.stringify(profiles).includes('fsa_'));
  assert.equal(f.authRuntime.store.snapshot().personSessions.length, 1);
  await assert.rejects(
    f.client().call(Methods.AUTH_SESSION_EXCHANGE, { code: pairing.code, ...f.device }),
    (error: unknown) => hasAuthErrorCode(error, 'PAIRING_FAILED'),
  );
});
