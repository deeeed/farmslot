import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  activePersonAccess,
  CredentialStoreRefusalError,
  CredentialStoreRuntime,
  CredentialStoreWriter,
  loadCredentialStore,
  parsePersonSessionToken,
  type PersonSessionAuthority,
  registerGatewayPresence,
} from '@farmslot/credential-store';
import {
  type GatewayAuthConnectResult,
  Methods,
  type PairingCreateResult,
  type PersonSessionGrant,
  type PersonSessionListResult,
  type PersonSessionRevokeResult,
} from '@farmslot/protocol';

import { GatewayClient, GatewayRpcError } from '../../../../packages/cli/src/gateway-client.js';

// No pool, user identity home or native host is consulted by the protocol fixture.
const privateFarm = realpathSync(mkdtempSync(join(tmpdir(), 'person-session-rpc-')));
const previousEnvironment = new Map<string, string | undefined>();
for (const [key, value] of Object.entries({
  FARMSLOT_ROOT: privateFarm,
  FARMSLOT_HOME: join(privateFarm, 'home'),
  FARMSLOT_POOL_DIR: join(privateFarm, 'pool'),
  FARMSLOT_PROJECTS_DIR: join(privateFarm, 'projects'),
  FARMSLOT_NATIVE_STATE_DIR: join(privateFarm, 'native'),
  FARMSLOT_WORKSPACE: undefined,
})) {
  previousEnvironment.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
for (const dir of ['scripts', 'pool', 'projects', 'home']) mkdirSync(join(privateFarm, dir));
writeFileSync(join(privateFarm, 'CLAUDE.md'), '');
writeFileSync(join(privateFarm, 'scripts/dev.sh'), '');
mkdirSync(join(privateFarm, 'services/gateway'), { recursive: true });
writeFileSync(join(privateFarm, 'services/gateway/package.json'), '{}');
writeFileSync(join(privateFarm, '.farm-status.json'), '{"slots":[]}');
test.after(() => {
  for (const [key, value] of previousEnvironment)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(privateFarm, { recursive: true, force: true });
});
const { createWebSocketServer } = await import('../server.js');
const { authorizeHttpRequest, createGatewayAuthRuntime, startCredentialFreshnessPolling } =
  await import('./auth.js');

function stateFixture() {
  const root = mkdtempSync(join(tmpdir(), 'person-session-'));

  const runtime = new CredentialStoreRuntime({ FARMSLOT_HOME: root });
  const clock = { now: Date.now() };
  const writer = new CredentialStoreWriter(runtime, false, () => clock.now);
  const person = writer.createPrincipal({ type: 'person', displayName: 'Person' }, []);
  const credential = writer.issueCredential(person.id, 'Sign-in credential');
  const device = { deviceName: 'Test device', deviceKind: 'cli' as const };
  const grant = () => writer.exchangePersonCredential(credential.secret, device);
  return {
    runtime,
    clock,
    writer,
    person,
    credential,
    device,
    grant,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function fixture(t: test.TestContext) {
  const value = stateFixture();
  t.after(value.dispose);
  return value;
}

function authority(grant: PersonSessionGrant): PersonSessionAuthority {
  const access = parsePersonSessionToken(grant.accessToken, 'fsa');
  assert.ok(access);
  return {
    principalId: grant.session.principalId,
    principalGeneration: grant.session.principalGeneration,
    sessionId: grant.session.id,
    accessId: access.id,
  };
}

function ended(error: unknown): boolean {
  return error instanceof CredentialStoreRefusalError && error.diagnostic === 'AUTH_SESSION_ENDED';
}

test('schema1 migration preserves credentials and bytes on a second read', (t) => {
  const f = fixture(t);
  const admin = f.writer.createPrincipal({ type: 'service', displayName: 'Retained admin' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  f.writer.issueCredential(admin.id, 'Retained automation credential');
  const historical = f.writer.createPrincipal({ type: 'person', displayName: 'Historical' }, []);
  f.writer.retirePrincipals([historical.id]);
  f.writer.createPrincipal({ type: 'person', displayName: 'Replacement' }, [], historical.id, {
    reuseRetiredId: true,
  });
  const before = f.runtime.snapshot();
  const legacy = Object.fromEntries(
    Object.entries(before).filter(
      ([key]) => key !== 'personSessions' && key !== 'personAccessTokens',
    ),
  );
  writeFileSync(f.runtime.path, JSON.stringify({ ...legacy, schemaVersion: 1 }));
  const after = loadCredentialStore(f.runtime.path);
  assert.equal(after.schemaVersion, 2);
  assert.deepEqual(after.principals, before.principals);
  assert.deepEqual(after.credentials, before.credentials);
  assert.deepEqual(after.principalIdReuses, before.principalIdReuses);
  assert.deepEqual(after.retiredPrincipalIds, before.retiredPrincipalIds);
  assert.deepEqual(after.personSessions, []);
  assert.deepEqual(after.personAccessTokens, []);
  const saved = readFileSync(f.runtime.path, 'utf8');
  loadCredentialStore(f.runtime.path);
  assert.equal(readFileSync(f.runtime.path, 'utf8'), saved);
});

test('schema1 migration refuses a live gateway without changing store bytes', (t) => {
  const f = fixture(t);
  const before = f.runtime.snapshot();
  const bytes = JSON.stringify({
    schemaVersion: 1,
    activatedAt: before.activatedAt,
    principals: before.principals,
    credentials: before.credentials,
  });
  writeFileSync(f.runtime.path, bytes);
  const release = registerGatewayPresence(
    { pid: process.pid, farmslotRoot: '/old-gateway', port: 7890 },
    f.runtime.env,
  );
  try {
    assert.throws(() => loadCredentialStore(f.runtime.path), /gateway is running/);
    assert.equal(readFileSync(f.runtime.path, 'utf8'), bytes);
  } finally {
    release();
  }
  const migrated = loadCredentialStore(f.runtime.path);
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.credentials, before.credentials);
});

test('issued tokens are hash-only on disk and survive a runtime restart', (t) => {
  const f = fixture(t);
  const grant = f.grant();
  assert.equal(Date.parse(grant.accessExpiresAt) - f.clock.now, 3_600_000);
  assert.equal(Date.parse(grant.session.refreshExpiresAt) - f.clock.now, 2_592_000_000);
  const bytes = readFileSync(f.runtime.path, 'utf8');
  for (const secret of [f.credential.secret, grant.accessToken, grant.refreshToken])
    assert.ok(!bytes.includes(secret));
  assert.ok(!('refreshSecret' in grant.session));
  const restarted = new CredentialStoreRuntime(f.runtime.env);
  assert.equal(
    activePersonAccess(restarted.snapshot(), authority(grant).accessId, f.clock.now)?.session.id,
    grant.session.id,
  );
});

test('access expires exactly at one hour without any store write', (t) => {
  const f = fixture(t);
  const grant = f.grant();
  const id = authority(grant).accessId;
  const bytes = readFileSync(f.runtime.path, 'utf8');
  f.clock.now += 3_600_000 - 1;
  assert.ok(activePersonAccess(f.runtime.snapshot(), id, f.clock.now));
  f.clock.now++;
  assert.equal(activePersonAccess(f.runtime.snapshot(), id, f.clock.now), undefined);
  assert.equal(readFileSync(f.runtime.path, 'utf8'), bytes);
});

test('refresh slides thirty days, keeps concurrent access and refuses exact expiry', (t) => {
  const f = fixture(t);
  const first = f.grant();
  f.clock.now += 60_000;
  const refreshed = f.writer.refreshPersonSession(first.refreshToken);
  assert.equal(refreshed.refreshToken, first.refreshToken);
  assert.equal(Date.parse(refreshed.session.refreshExpiresAt), f.clock.now + 2_592_000_000);
  assert.ok(activePersonAccess(f.runtime.snapshot(), authority(first).accessId, f.clock.now));
  assert.ok(activePersonAccess(f.runtime.snapshot(), authority(refreshed).accessId, f.clock.now));
  f.clock.now = Date.parse(refreshed.session.refreshExpiresAt);
  const bytes = readFileSync(f.runtime.path, 'utf8');
  assert.throws(() => f.writer.refreshPersonSession(first.refreshToken), ended);
  assert.equal(readFileSync(f.runtime.path, 'utf8'), bytes);
});

test('device revocation is independent, idempotent and cannot cross a person boundary', (t) => {
  const f = fixture(t);
  const first = f.grant();
  const second = f.grant();
  const otherPerson = f.writer.createPrincipal({ type: 'person', displayName: 'Other' }, []);
  const other = f.writer.issuePersonSession(otherPerson.id, 0, f.device);
  const actor = authority(first);
  const revoked = f.writer.revokePersonSession(actor, second.session.id);
  assert.ok(revoked.revokedAt);
  assert.deepEqual(f.writer.revokePersonSession(actor, second.session.id), revoked);
  assert.equal(
    activePersonAccess(f.runtime.snapshot(), authority(second).accessId, f.clock.now),
    undefined,
  );
  assert.ok(activePersonAccess(f.runtime.snapshot(), actor.accessId, f.clock.now));
  assert.ok(activePersonAccess(f.runtime.snapshot(), authority(other).accessId, f.clock.now));
  const bytes = readFileSync(f.runtime.path, 'utf8');
  assert.throws(
    () => f.writer.revokePersonSession(actor, other.session.id),
    (error: unknown) =>
      error instanceof CredentialStoreRefusalError && error.diagnostic === 'AUTH_FORBIDDEN',
  );
  assert.equal(readFileSync(f.runtime.path, 'utf8'), bytes);
  assert.equal(f.writer.listPersonSessions(actor).length, 2);
});

test('source credential revocation closes device tokens and refresh authority', (t) => {
  const f = fixture(t);
  const grant = f.grant();
  let invalidated: string[] = [];
  f.runtime.onChange((change) => {
    invalidated = change.revokedSessionIds ?? [];
  });
  f.writer.revokeCredential(f.credential.record.id);
  assert.deepEqual(invalidated, [grant.session.id]);
  assert.equal(
    activePersonAccess(f.runtime.snapshot(), authority(grant).accessId, f.clock.now),
    undefined,
  );
  assert.throws(() => f.writer.refreshPersonSession(grant.refreshToken), ended);
});

test('a revoked acting device cannot mutate another device while its person still exists', (t) => {
  const f = fixture(t);
  const first = f.grant();
  const second = f.grant();
  const actor = authority(first);
  f.writer.revokePersonSession(authority(second), first.session.id);
  const bytes = readFileSync(f.runtime.path, 'utf8');
  assert.throws(() => f.writer.revokePersonSession(actor, second.session.id), ended);
  assert.equal(readFileSync(f.runtime.path, 'utf8'), bytes);
});

async function rpcFixture(t: test.TestContext, operator = false) {
  const f = stateFixture();
  if (operator) f.writer.grantRole(f.person.id, 'operator', { kind: 'global' });
  const admin = f.writer.createPrincipal({ type: 'service', displayName: 'Automation' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const adminCredential = f.writer.issueCredential(admin.id, 'Automation');
  const runtime = createGatewayAuthRuntime(f.runtime.env, () => f.clock.now);
  const server = createServer((req, res) => {
    if (!authorizeHttpRequest({ runtime, req, res, resource: 'run-artifact' })) return;
    res.end('authorized');
  });
  const wss = createWebSocketServer(server, runtime);
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    f.dispose();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = 'ws://127.0.0.1:' + address.port + '/ws';
  const client = (token?: string) =>
    new GatewayClient({ url, timeout: 2500, credential: token ? { token } : null });
  return {
    ...f,
    adminCredential,
    authRuntime: runtime,
    url,
    http: 'http://127.0.0.1:' + address.port,
    client,
  };
}

async function httpStatus(url: string, token: string): Promise<number> {
  const response = await fetch(url, { headers: { authorization: 'Bearer ' + token } });
  await response.arrayBuffer();
  return response.status;
}

function rpcCode(code: string) {
  return (error: unknown) => error instanceof GatewayRpcError && error.code === code;
}

test('public gateway exchanges person credentials, denies raw/refresh access and limits self-service to this person', async (t) => {
  const f = await rpcFixture(t);
  const grant = await f.client().call<PersonSessionGrant>(Methods.AUTH_SESSION_EXCHANGE, {
    credential: f.credential.secret,
    ...f.device,
  });
  await assert.rejects(
    () => f.client(f.credential.secret).connect(),
    rpcCode('AUTH_PERSON_SESSION_REQUIRED'),
  );
  await assert.rejects(() => f.client(grant.refreshToken).connect(), rpcCode('AUTH_FAILED'));
  const connection = await f.client(grant.accessToken).connect();
  t.after(() => connection.close());
  const devices = await connection.call<PersonSessionListResult>(Methods.AUTH_SESSION_LIST);
  assert.equal(devices.sessions[0]?.id, grant.session.id);
  await assert.rejects(() => connection.call(Methods.FLEET_STATUS), rpcCode('AUTH_FORBIDDEN'));
  await assert.rejects(
    () => connection.call(Methods.AUTH_SESSION_LIST, { principalId: 'other' }),
    rpcCode('INVALID_PARAMS'),
  );
});

test('public revoke acknowledges before closing its socket and withdraws HTTP access', async (t) => {
  const f = await rpcFixture(t, true);
  const grant = await f.client().call<PersonSessionGrant>(Methods.AUTH_SESSION_EXCHANGE, {
    credential: f.credential.secret,
    ...f.device,
  });
  assert.equal(await httpStatus(f.http, grant.accessToken), 200);
  assert.equal(await httpStatus(f.http, grant.refreshToken), 401);
  const connection = await f.client(grant.accessToken).connect();
  t.after(() => connection.close());
  const result = await connection.call<PersonSessionRevokeResult>(Methods.AUTH_SESSION_REVOKE, {
    sessionId: grant.session.id,
  });
  assert.ok(result.session.revokedAt);
  assert.equal(await httpStatus(f.http, grant.accessToken), 401);
});

test('production authentication poll expires an idle socket without requests or store writes', async (t) => {
  const f = await rpcFixture(t);
  const grant = await f.client().call<PersonSessionGrant>(Methods.AUTH_SESSION_EXCHANGE, {
    credential: f.credential.secret,
    ...f.device,
  });
  const connection = await f.client(grant.accessToken).connect();
  t.after(() => connection.close());
  const before = readFileSync(f.runtime.path, 'utf8');
  const stop = startCredentialFreshnessPolling(f.authRuntime);
  t.after(stop);
  f.clock.now += 3_600_000;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      connection.onClose(resolve);
      deadline = setTimeout(
        () => reject(new Error('Idle access remained open after its expiry poll')),
        3000,
      );
    });
  } finally {
    clearTimeout(deadline);
  }
  assert.equal(readFileSync(f.runtime.path, 'utf8'), before);
});

test('person pairing never issues a long-lived device credential and its code is one-use', async (t) => {
  const f = await rpcFixture(t);
  const adminCredential = f.adminCredential;
  const code = await f
    .client(adminCredential.secret)
    .call<PairingCreateResult>(Methods.PAIRING_CREATE, {
      gatewayUrl: f.url,
      authority: { kind: 'existing-principal', principalId: f.person.id },
    });
  const count = f.runtime.snapshot().credentials.length;
  await assert.rejects(
    () => f.client().call(Methods.PAIRING_EXCHANGE, { code: code.code }),
    rpcCode('AUTH_PERSON_SESSION_REQUIRED'),
  );
  const grant = await f
    .client()
    .call<PersonSessionGrant>(Methods.AUTH_SESSION_EXCHANGE, { code: code.code, ...f.device });
  assert.equal(grant.session.principalId, f.person.id);
  assert.equal(f.runtime.snapshot().credentials.length, count);
  await assert.rejects(
    () => f.client().call(Methods.AUTH_SESSION_EXCHANGE, { code: code.code, ...f.device }),
    rpcCode('PAIRING_FAILED'),
  );
  assert.equal(
    (
      await f.client(adminCredential.secret).call<GatewayAuthConnectResult>(Methods.AUTH_CONNECT, {
        clientKind: 'ui',
        token: adminCredential.secret,
      })
    ).principal?.subjectKind,
    'service',
  );
});
