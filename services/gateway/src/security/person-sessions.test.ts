import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Command } from 'commander';

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
  hasAuthErrorCode,
  Methods,
  type PairingCreateResult,
  PersonSessionEndedError,
  type PersonSessionGrant,
  type PersonSessionListResult,
  type PersonSessionRevokeResult,
} from '@farmslot/protocol';

import { registerAuthCommands } from '../../../../packages/cli/src/commands/auth.js';
import { GatewayClient, GatewayRpcError } from '../../../../packages/cli/src/gateway-client.js';
import {
  loadProfiles,
  profilesPath,
  resolveGatewayTarget,
  saveProfiles,
} from '../../../../packages/cli/src/gateway-profiles.js';
import { OutputContext } from '../../../../packages/cli/src/output.js';

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
const {
  authorizeHttpRequest,
  createGatewayAuthRuntime,
  initializeGatewayIdentity,
  startCredentialFreshnessPolling,
} = await import('./auth.js');

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

export function authority(grant: PersonSessionGrant): PersonSessionAuthority {
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

interface SessionProofResource {
  contentType: string;
  body: string | Buffer;
}
export async function rpcFixture(
  t: test.TestContext,
  operator = false,
  resources: Record<string, SessionProofResource> = {},
  port = 0,
) {
  const f = stateFixture();
  if (operator) f.writer.grantRole(f.person.id, 'operator', { kind: 'global' });
  const admin = f.writer.createPrincipal({ type: 'service', displayName: 'Automation' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const adminCredential = f.writer.issueCredential(admin.id, 'Automation');
  const runtime = createGatewayAuthRuntime(f.runtime.env, () => f.clock.now);
  const { url, http } = await startSessionRpcServer(t, runtime, f.dispose, resources, port);
  const client = (token?: string) =>
    new GatewayClient({ url, timeout: 2500, credential: token ? { token } : null });
  return {
    ...f,
    adminCredential,
    authRuntime: runtime,
    url,
    http,
    client,
  };
}

async function startSessionRpcServer(
  t: test.TestContext,
  runtime: ReturnType<typeof createGatewayAuthRuntime>,
  cleanup: () => void,
  resources: Record<string, SessionProofResource> = {},
  port = 0,
) {
  const server = createServer((req, res) => {
    if (!authorizeHttpRequest({ runtime, req, res, resource: 'run-artifact' })) return;
    const resource = resources[new URL(req.url ?? '/', 'http://localhost').pathname];
    if (resource) res.setHeader('Content-Type', resource.contentType);
    res.end(resource?.body ?? 'authorized');
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
    cleanup();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = 'ws://127.0.0.1:' + address.port + '/ws';
  return { url, http: 'http://127.0.0.1:' + address.port };
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

test('the CLI refreshes its selected profile, authenticates its TUI, and clears only confirmed ended authority', async (t) => {
  const f = await rpcFixture(t);
  const grant = await f.client().call<PersonSessionGrant>(Methods.AUTH_SESSION_EXCHANGE, {
    credential: f.credential.secret,
    ...f.device,
  });
  const path = profilesPath();
  t.after(() => rmSync(path, { force: true }));
  saveProfiles(
    {
      active: 'person',
      gateways: {
        person: {
          url: f.url,
          authMode: 'token',
          personSession: { session: grant.session, refreshToken: grant.refreshToken },
        },
        automation: {
          url: 'ws://unrelated.invalid',
          authMode: 'token',
          secret: 'retained-service-secret',
        },
      },
    },
    path,
  );
  const target = resolveGatewayTarget({ gateway: 'person' });
  const client = new GatewayClient({
    url: target.url,
    timeout: 2500,
    credential: target.credential,
  });
  const devices = await client.call<PersonSessionListResult>(Methods.AUTH_SESSION_LIST);
  assert.equal(devices.sessions[0]?.id, grant.session.id);
  const stored = readFileSync(path, 'utf8');
  assert.ok(!stored.includes('fsa_'));
  assert.ok(!stored.includes(f.credential.secret));
  assert.equal(loadProfiles(path).gateways.person.personSession?.refreshToken, grant.refreshToken);
  const connection = await client.connect();
  try {
    const devices = await connection.call<PersonSessionListResult>(Methods.AUTH_SESSION_LIST);
    assert.equal(devices.sessions[0]?.id, grant.session.id);
  } finally {
    connection.close();
  }
  f.writer.revokePersonSession(authority(grant), grant.session.id);
  await assert.rejects(client.call(Methods.AUTH_SESSION_LIST), PersonSessionEndedError);
  const after = loadProfiles(path);
  assert.equal(after.gateways.person.personSession, undefined);
  assert.equal(after.gateways.automation.secret, 'retained-service-secret');
});

function authCommand(t: test.TestContext) {
  const output: unknown[] = [];
  t.mock.method(OutputContext.prototype, 'writeJson', (value: unknown) => {
    output.push(value);
  });
  t.mock.method(process, 'exit', (code?: number | string | null): never => {
    throw new Error(`Unexpected CLI exit ${code}`);
  });
  return {
    output,
    run: async (...args: string[]) => {
      const program = new Command().option('--json');
      program.exitOverride();
      registerAuthCommands(program);
      await program.parseAsync(['node', 'farmslot', '--json', ...args]);
    },
  };
}

test('the public CLI login persists only a person refresh token and nonsecret metadata', async (t) => {
  const f = await rpcFixture(t);
  const path = profilesPath();
  t.after(() => rmSync(path, { force: true }));
  saveProfiles({ active: 'person', gateways: { person: { url: f.url } } }, path);
  const command = authCommand(t);
  await command.run('login', 'person', '--token', f.credential.secret);
  const profile = loadProfiles(path).gateways.person;
  assert.ok(profile.personSession);
  assert.equal(profile.secret, undefined);
  const persisted = readFileSync(path, 'utf8');
  assert.ok(!persisted.includes(f.credential.secret));
  assert.ok(!persisted.includes('fsa_'));
  const rendered = JSON.stringify(command.output);
  assert.ok(!rendered.includes(profile.personSession.refreshToken));
  assert.ok(!rendered.includes(f.credential.secret));
});

test('the public CLI logout confirms revocation before removing its person refresh token', async (t) => {
  const f = await rpcFixture(t);
  const grant = f.grant();
  const path = profilesPath();
  t.after(() => rmSync(path, { force: true }));
  saveProfiles(
    {
      active: 'person',
      gateways: {
        person: {
          url: f.url,
          authMode: 'token',
          personSession: { session: grant.session, refreshToken: grant.refreshToken },
        },
      },
    },
    path,
  );
  const command = authCommand(t);
  await command.run('logout', 'person', '--yes');
  assert.equal(loadProfiles(path).gateways.person.personSession, undefined);
  await assert.rejects(
    f.client().call(Methods.AUTH_SESSION_REFRESH, { refreshToken: grant.refreshToken }),
    rpcCode('AUTH_SESSION_ENDED'),
  );
});

test('CLI access-token input cannot replace or overwrite a saved service credential', async (t) => {
  const f = await rpcFixture(t);
  const grant = f.grant();
  const path = profilesPath();
  t.after(() => rmSync(path, { force: true }));
  saveProfiles(
    {
      active: 'selected',
      gateways: { selected: { url: f.url, authMode: 'token', secret: f.adminCredential.secret } },
    },
    path,
  );
  const before = readFileSync(path, 'utf8');
  const command = authCommand(t);
  await assert.rejects(
    command.run('login', 'selected', '--token', grant.accessToken),
    /Unexpected CLI exit/,
  );
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('CLI refusal does not classify or delete an opaque legacy service profile', async (t) => {
  const f = await rpcFixture(t);
  const path = profilesPath();
  t.after(() => rmSync(path, { force: true }));
  saveProfiles(
    {
      active: 'selected',
      gateways: { selected: { url: f.url, authMode: 'token', secret: 'unverified-legacy-value' } },
    },
    path,
  );
  const before = readFileSync(path, 'utf8');
  const command = authCommand(t);
  await assert.rejects(command.run('login', 'selected'), /Unexpected CLI exit/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('CLI classifies a stored person credential through the gateway and requires fresh sign-in', async (t) => {
  const f = await rpcFixture(t);
  const path = profilesPath();
  t.after(() => rmSync(path, { force: true }));
  saveProfiles(
    {
      active: 'selected',
      gateways: { selected: { url: f.url, authMode: 'token', secret: f.credential.secret } },
    },
    path,
  );
  const command = authCommand(t);
  await assert.rejects(command.run('login', 'selected'), /Unexpected CLI exit/);
  const after = loadProfiles(path).gateways.selected;
  assert.equal(after.secret, undefined);
  assert.equal(after.personSession, undefined);
  assert.equal(f.authRuntime.store.snapshot().personSessions.length, 0);
});

test('CLI person pairing consumes its invitation once and saves a refresh-only device session', async (t) => {
  const f = await rpcFixture(t);
  const path = profilesPath();
  t.after(() => rmSync(path, { force: true }));
  saveProfiles({ active: 'selected', gateways: { selected: { url: f.url } } }, path);
  const pairing = await f
    .client(f.adminCredential.secret)
    .call<PairingCreateResult>(Methods.PAIRING_CREATE, {
      gatewayUrl: f.url,
      authority: { kind: 'existing-principal', principalId: f.person.id },
    });
  const command = authCommand(t);
  await command.run('login', 'selected', '--code', pairing.code);
  const after = loadProfiles(path).gateways.selected;
  assert.ok(after.personSession);
  assert.equal(after.secret, undefined);
  await assert.rejects(
    f.client().call(Methods.AUTH_SESSION_EXCHANGE, { code: pairing.code, ...f.device }),
    rpcCode('PAIRING_FAILED'),
  );
});

test('first local startup persists one device and renews it through the production gateway', async (t) => {
  const { ensureLocalCredential } = await import('../../../../packages/cli/src/commands/up.js');
  const { probeGatewayAuth } = await import('../../../../packages/cli/src/gateway-auth.js');
  const home = mkdtempSync(join(tmpdir(), 'local-start-session-'));
  const previousHome = process.env.FARMSLOT_HOME;
  const input = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const output = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  t.after(() => {
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    if (input) Object.defineProperty(process.stdin, 'isTTY', input);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (output) Object.defineProperty(process.stdout, 'isTTY', output);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  });
  process.env.FARMSLOT_HOME = home;
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const initial = ensureLocalCredential(8801);
  assert.ok(initial.personSession);
  const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  const server = await startSessionRpcServer(t, runtime, () =>
    rmSync(home, { recursive: true, force: true }),
  );
  const profile = loadProfiles();
  const port = Number(new URL(server.url).port);
  profile.gateways.local.url = 'ws://localhost:' + port;
  saveProfiles(profile);
  const restored = ensureLocalCredential(port);
  assert.equal(restored.personSession?.session.id, initial.personSession.session.id);
  assert.equal(
    (await probeGatewayAuth(profile.gateways.local.url, restored)).state,
    'authenticated',
  );
  const persisted = loadProfiles().gateways.local;
  assert.equal(persisted.secret, undefined);
  assert.equal(persisted.personSession?.session.id, initial.personSession.session.id);
  assert.equal(runtime.store.snapshot().personSessions.length, 1);
  assert.ok(!readFileSync(profilesPath(), 'utf8').includes('fsa_'));
});

test('revoked local sign-in preserves the owned gateway and pid for pairing again', async (t) => {
  const { cleanupFailedGatewayStartup, verifyTokenAuth } =
    await import('../../../../packages/cli/src/commands/up.js');
  const f = await rpcFixture(t, true);
  f.writer.grantRole(f.person.id, 'admin', { kind: 'global' });
  const local = f.grant();
  const browser = f.grant();
  saveProfiles({
    gateways: {
      local: {
        url: f.url,
        authMode: 'token',
        personSession: { session: local.session, refreshToken: local.refreshToken },
      },
    },
  });
  const target = resolveGatewayTarget({ gateway: 'local' });
  assert.ok(target.credential);
  const pidPath = join(privateFarm, 'home', 'gateway.pid');
  writeFileSync(pidPath, '47123\n');
  t.after(() => {
    rmSync(pidPath, { force: true });
    rmSync(profilesPath(), { force: true });
  });
  await f.client(browser.accessToken).call(Methods.AUTH_SESSION_REVOKE, {
    sessionId: local.session.id,
  });
  const kill = t.mock.method(process, 'kill', () => {
    throw new Error('Ended sign-in must not signal the healthy gateway');
  });
  let failure: unknown;
  try {
    await verifyTokenAuth(Number(new URL(f.url).port), target.credential, new OutputContext(true));
  } catch (error) {
    failure = error;
    await cleanupFailedGatewayStartup(47123, error);
  }
  assert.ok(hasAuthErrorCode(failure, 'AUTH_SESSION_ENDED'));
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /farmslot login local --code <code from a signed-in/);
  assert.equal(kill.mock.callCount(), 0);
  assert.equal(readFileSync(pidPath, 'utf8'), '47123\n');
  assert.equal(loadProfiles().gateways.local.personSession, undefined);
  const invitation = await f
    .client(browser.accessToken)
    .call<PairingCreateResult>(Methods.PAIRING_CREATE, {
      gatewayUrl: f.url,
      authority: { kind: 'existing-principal', principalId: f.person.id },
    });
  await authCommand(t).run('login', 'local', '--code', invitation.code);
  assert.ok(loadProfiles().gateways.local.personSession);
});

test('online activation exchanges its one-time owner credential before saving a CLI profile', async (t) => {
  const { persistOwnerCredential } =
    await import('../../../../packages/cli/src/commands/credential.js');
  const { ensureLocalCredential } = await import('../../../../packages/cli/src/commands/up.js');
  const { probeGatewayAuth } = await import('../../../../packages/cli/src/gateway-auth.js');
  const home = mkdtempSync(join(tmpdir(), 'activation-device-session-'));
  const previousHome = process.env.FARMSLOT_HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
  });
  process.env.FARMSLOT_HOME = home;
  const runtime = createGatewayAuthRuntime({
    FARMSLOT_HOME: home,
    FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  });
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  const server = await startSessionRpcServer(t, runtime, () =>
    rmSync(home, { recursive: true, force: true }),
  );
  const client = new GatewayClient({ url: server.url, timeout: 2500, credential: null });
  const created = await client.call<import('@farmslot/protocol').PrincipalCreateResult>(
    Methods.PRINCIPAL_CREATE,
    { subject: { type: 'service', displayName: 'Bootstrap target' }, roles: [] },
  );
  const issue = await client.call<import('@farmslot/protocol').CredentialIssueResult>(
    Methods.CREDENTIAL_ISSUE,
    { principalId: created.principal.id, displayName: 'Bootstrap service' },
  );
  assert.equal(issue.activationLatched, true);
  assert.ok(issue.adminGrant);
  const port = Number(new URL(server.url).port);
  const url = 'ws://localhost:' + port;
  saveProfiles({
    active: 'remote',
    gateways: {
      remote: { url: 'wss://remote.invalid/ws', authMode: 'token', secret: 'retained-service' },
    },
  });
  await persistOwnerCredential(url, 'local', issue.adminGrant.secret);
  const profiles = loadProfiles();
  assert.equal(profiles.active, 'remote');
  assert.equal(profiles.gateways.remote.secret, 'retained-service');
  assert.ok(profiles.gateways.local.personSession);
  const raw = readFileSync(profilesPath(), 'utf8');
  assert.ok(!raw.includes(issue.adminGrant.secret) && !raw.includes('fsa_'));
  assert.equal((await probeGatewayAuth(url, ensureLocalCredential(port))).state, 'authenticated');
  assert.equal(runtime.store.snapshot().personSessions.length, 1);
});
