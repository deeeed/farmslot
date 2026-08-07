// @farmslot:serial

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { Methods } from '@farmslot/protocol';

import {
  authorizeHttpRequest,
  createGatewayAuthRuntime,
  initializeGatewayIdentity,
  latchActivationForExposure,
} from './auth.js';
import {
  authorizeGatewayMethod,
  authorizeStoredRunEffect,
  isNodeSubjectSession,
} from './authorization.js';
import {
  formatCredentialWire,
  generateCredentialId,
  generateCredentialSecret,
  hashSecret,
  parseCredentialWire,
  verifySecret,
} from './credential-secret.js';
import {
  credentialStorePath,
  CredentialStoreRuntime,
  loadCredentialStore,
  saveCredentialStore,
} from './credential-store.js';
import { withCredentialLock } from './credential-store-lock.js';
import { CredentialStoreWriter, readCredentialStoreOffline } from './credential-store-writer.js';
import {
  assertNoLiveGatewaysUnlocked,
  gatewayPresenceDirectory,
  listLiveGateways,
  registerGatewayPresence,
} from './gateway-presence.js';

const operatorMethods = [
  Methods.NODES_LIST,
  Methods.NODE_HEALTH,
  Methods.NODE_HEALTH_ALL,
  Methods.RUN_LIST,
  Methods.DISPATCH_QUEUE_LIST,
  Methods.BACKLOG_LIST,
  Methods.WORK_GRAPH_GET,
  Methods.WORK_GRAPH_LIST,
] as const;

test('credential wire format is unambiguous and stored secrets are scrypt-only', () => {
  const id = generateCredentialId();
  const raw = `${generateCredentialSecret()}_suffix`;
  assert.match(id, /^[a-f0-9]{32}$/u);
  assert.deepEqual(parseCredentialWire(formatCredentialWire(id, raw)), {
    credentialId: id,
    secret: raw,
  });
  assert.equal(parseCredentialWire('not-a-credential'), null);

  const stored = hashSecret(raw);
  assert.equal(stored.scheme, 'scrypt-v1');
  assert.equal(verifySecret(raw, stored), true);
  assert.equal(verifySecret(`${raw}-wrong`, stored), false);
  assert.equal(verifySecret(raw, { ...stored, hash: 'bad' }), false);
});

test('credential store rejects unsupported and node-role records and saves mode 0600', () => {
  const env = isolatedEnv();
  const path = credentialStorePath(env);
  writeFileSync(
    path,
    JSON.stringify({ schemaVersion: 2, activatedAt: null, principals: [], credentials: [] }),
    { mode: 0o600 },
  );
  assert.throws(() => loadCredentialStore(path), /unsupported schemaVersion 2/u);

  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      activatedAt: null,
      principals: [
        {
          id: 'bad-node',
          subject: { type: 'node', displayName: 'bad', machine: 'bad' },
          roles: [{ role: 'admin', scope: { kind: 'global' } }],
        },
      ],
      credentials: [],
    }),
  );
  assert.throws(() => loadCredentialStore(path), /node subject and must have roles/u);

  writeFileSync(
    path,
    JSON.stringify({ schemaVersion: 1, activatedAt: null, principals: [], credentials: [] }),
  );
  const runtime = new CredentialStoreRuntime(env);
  new CredentialStoreWriter(runtime).createPrincipal({ type: 'person', displayName: 'owner' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
});

test('credential store writes are atomic, locked, permission-safe, and temp-clean', () => {
  const env = isolatedEnv();
  const runtime = new CredentialStoreRuntime(env);
  const writer = new CredentialStoreWriter(runtime);
  writer.createPrincipal({ type: 'person', displayName: 'first' }, []);
  const path = runtime.path;

  chmodSync(path, 0o666);
  writer.createPrincipal({ type: 'person', displayName: 'second' }, []);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(
    readdirSync(dirname(path)).some((name) => name.endsWith('.tmp')),
    false,
  );

  const previous = readFileSync(path, 'utf8');
  const tempPath = `${path}.${process.pid}.tmp`;
  mkdirSync(tempPath);
  assert.throws(
    () => writer.createPrincipal({ type: 'person', displayName: 'interrupted' }, []),
    /EISDIR|illegal operation on a directory/u,
  );
  assert.equal(readFileSync(path, 'utf8'), previous);
  rmSync(tempPath, { recursive: true });

  assert.throws(
    () => saveCredentialStore(loadCredentialStore(path), path),
    /without credentials\.lock/u,
  );
});

test('credential lock serializes concurrent writers, reclaims stale locks, and preserves ownership', async () => {
  const env = isolatedEnv();
  const home = env.FARMSLOT_HOME!;
  const goPath = join(home, 'writers.go');
  const children = ['concurrent-a', 'concurrent-b'].map((name) => {
    const readyPath = join(home, `${name}.ready`);
    return {
      readyPath,
      child: spawnEval(
        `
          const { existsSync, writeFileSync } = await import('node:fs');
          const { CredentialStoreRuntime, CredentialStoreWriter } = await import('@farmslot/credential-store');
          writeFileSync(process.env.WRITER_READY, 'ready');
          while (!existsSync(process.env.WRITER_GO)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          const env = { FARMSLOT_HOME: process.env.WRITER_HOME };
          new CredentialStoreWriter(new CredentialStoreRuntime(env)).createPrincipal(
            { type: 'person', displayName: process.env.WRITER_NAME },
            [],
          );
        `,
        {
          WRITER_HOME: home,
          WRITER_NAME: name,
          WRITER_READY: readyPath,
          WRITER_GO: goPath,
        },
      ),
    };
  });
  await waitFor(() => children.every(({ readyPath }) => existsSync(readyPath)));
  writeFileSync(goPath, 'go');
  await Promise.all(children.map(({ child }) => waitForChild(child)));
  assert.deepEqual(
    loadCredentialStore(credentialStorePath(env))
      .principals.map((principal) => principal.subject.displayName)
      .sort(),
    ['concurrent-a', 'concurrent-b'],
  );

  const lockPath = join(home, 'credentials.lock');
  writeFileSync(lockPath, '2147483647\n');
  withCredentialLock(() => undefined, env);
  assert.equal(existsSync(lockPath), false);

  withCredentialLock(() => writeFileSync(lockPath, '123456789\n'), env);
  assert.equal(readFileSync(lockPath, 'utf8'), '123456789\n');
  unlinkSync(lockPath);
});

test('identity domains isolate homes while gateways in one home share activation and credentials', () => {
  const fakeUserHome = mkdtempSync(join(tmpdir(), 'farmslot-fake-user-home-'));
  const firstEnv = isolatedEnv({ HOME: fakeUserHome });
  const secondEnv = isolatedEnv({ HOME: fakeUserHome });
  const first = createGatewayAuthRuntime(firstEnv);
  initializeGatewayIdentity(first, { host: '127.0.0.1' });
  const admin = first.writer.createPrincipal({ type: 'person', displayName: 'domain-admin' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const issued = first.writer.issueCredential(admin.id, 'domain-admin');

  const sameDomain = createGatewayAuthRuntime(firstEnv);
  initializeGatewayIdentity(sameDomain, { host: '127.0.0.1' });
  assert.equal(sameDomain.resolver.isSoloMode(), false);
  assert.equal(sameDomain.resolver.resolveSecret(issued.secret, 'token').ok, true);

  const otherDomain = createGatewayAuthRuntime(secondEnv);
  initializeGatewayIdentity(otherDomain, { host: '127.0.0.1' });
  assert.equal(otherDomain.resolver.isSoloMode(), true);
  assert.equal(otherDomain.store.snapshot().principals.length, 0);
  assert.equal(existsSync(join(fakeUserHome, '.farmslot')), false);
});

test('presence coordination closes registration races, reclaims dead entries, and supports shared mode', async () => {
  const env = isolatedEnv();
  const home = env.FARMSLOT_HOME!;
  const offlineReady = join(home, 'offline-race.ready');
  const offlineGo = join(home, 'offline-race.go');
  const offlineRegistered = join(home, 'offline-race.registered');
  const offlineStop = join(home, 'offline-race.stop');
  const offlineChild = spawnPresenceWorker({
    home,
    readyPath: offlineReady,
    goPath: offlineGo,
    registeredPath: offlineRegistered,
    stopPath: offlineStop,
    port: 7788,
  });
  await waitFor(() => existsSync(offlineReady));
  withCredentialLock(() => {
    writeFileSync(offlineGo, 'go');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    assert.equal(existsSync(offlineRegistered), false);
    assertNoLiveGatewaysUnlocked(env);
    const path = credentialStorePath(env);
    const store = loadCredentialStore(path);
    saveCredentialStore(
      {
        ...store,
        principals: [
          ...store.principals,
          { id: 'offline-won', subject: { type: 'person', displayName: 'offline-won' }, roles: [] },
        ],
      },
      path,
    );
  }, env);
  await waitFor(() => existsSync(offlineRegistered));
  assert.equal(loadCredentialStore(credentialStorePath(env)).principals[0]?.id, 'offline-won');
  writeFileSync(offlineStop, 'stop');
  await waitForChild(offlineChild);

  const gatewayReady = join(home, 'gateway-race.ready');
  const gatewayGo = join(home, 'gateway-race.go');
  const gatewayRegistered = join(home, 'gateway-race.registered');
  const gatewayStop = join(home, 'gateway-race.stop');
  writeFileSync(gatewayGo, 'go');
  const gatewayChild = spawnPresenceWorker({
    home,
    readyPath: gatewayReady,
    goPath: gatewayGo,
    registeredPath: gatewayRegistered,
    stopPath: gatewayStop,
    port: 7789,
  });
  await waitFor(() => existsSync(gatewayRegistered));
  assert.throws(
    () =>
      new CredentialStoreWriter(new CredentialStoreRuntime(env), true).createPrincipal(
        { type: 'person', displayName: 'gateway-won' },
        [],
      ),
    /gateway is running/u,
  );
  writeFileSync(gatewayStop, 'stop');
  await waitForChild(gatewayChild);

  const presenceDirectory = gatewayPresenceDirectory(env);
  mkdirSync(presenceDirectory, { recursive: true });
  writeFileSync(
    join(presenceDirectory, 'dead.json'),
    `${JSON.stringify({ pid: 2147483647, farmslotRoot: '/dead', port: 9999 })}\n`,
  );
  assert.deepEqual(listLiveGateways(env), []);
  assert.equal(existsSync(presenceDirectory), false);

  const releaseFirst = registerGatewayPresence(
    { pid: process.pid, farmslotRoot: '/gateway-a', port: 8801 },
    env,
  );
  const releaseSecond = registerGatewayPresence(
    { pid: process.pid, farmslotRoot: '/gateway-b', port: 8802 },
    env,
  );
  assert.deepEqual(
    listLiveGateways(env)
      .map((presence) => presence.port)
      .sort(),
    [8801, 8802],
  );
  releaseSecond();
  releaseFirst();
});

test('presence registration reclaims an exact stale entry after PID reuse', () => {
  const env = isolatedEnv();
  const presence = { pid: process.pid, farmslotRoot: '/gateway-reused', port: 8811 };
  const directory = gatewayPresenceDirectory(env);
  const suffix = createHash('sha256')
    .update(`${presence.pid}\0${presence.farmslotRoot}\0${presence.port}`)
    .digest('hex')
    .slice(0, 16);
  const path = join(directory, `${presence.pid}-${suffix}.json`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...presence, stalePidReuseBaseline: true })}\n`);

  const release = registerGatewayPresence(presence, env);
  try {
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), presence);
    assert.deepEqual(listLiveGateways(env), [presence]);
  } finally {
    release();
  }
});

test('gateway SIGINT and SIGTERM cleanup remove identity-domain presence', async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const env = isolatedEnv({ FARMSLOT_GATEWAY_TOKEN: `signal-${signal}` });
    const port = await availablePort();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: resolve(process.cwd()),
      env: {
        ...process.env,
        ...env,
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: String(port),
        FARMSLOT_DISABLE_ORCHESTRATION: '1',
        FARMSLOT_LOCAL_HEALTH_POLL: '0',
        FARMSLOT_RESOURCE_POLL_ALL: '0',
        FARMSLOT_STARTUP_BRANCH_PREWARM: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const presenceDirectory = gatewayPresenceDirectory(env);
    await waitFor(
      () => existsSync(presenceDirectory) && readdirSync(presenceDirectory).length === 1,
      10_000,
    );
    assert.equal(child.kill(signal), true);
    await waitForChild(child, [signal === 'SIGINT' ? 130 : 143]);
    assert.equal(
      existsSync(presenceDirectory) ? readdirSync(presenceDirectory).length : 0,
      0,
      `${signal} should remove its presence entry`,
    );
  }
});

test('HTTP transport matrix keeps tokens and legacy passwords unambiguous end to end', async () => {
  const issuedRuntime = createGatewayAuthRuntime(isolatedEnv());
  initializeGatewayIdentity(issuedRuntime, { host: '127.0.0.1' });
  const admin = issuedRuntime.writer.createPrincipal(
    { type: 'person', displayName: 'http-admin' },
    [{ role: 'admin', scope: { kind: 'global' } }],
  );
  const issued = issuedRuntime.writer.issueCredential(admin.id, 'http-admin');
  await withProtectedHttpServer(issuedRuntime, async (origin) => {
    assert.equal(await httpStatus(origin, { authorization: `Bearer ${issued.secret}` }), 200);
    assert.equal(await httpStatus(`${origin}?token=${encodeURIComponent(issued.secret)}`), 200);
    assert.equal(
      await httpStatus(origin, { cookie: `farmslot_gateway_credential=${issued.secret}` }),
      200,
    );
    assert.equal(await httpStatus(origin, { authorization: basicAuth(issued.secret) }), 401);
  });

  const password = 'legacy password';
  const passwordRuntime = createGatewayAuthRuntime(
    isolatedEnv({ FARMSLOT_GATEWAY_PASSWORD: password }),
  );
  initializeGatewayIdentity(passwordRuntime, { host: '127.0.0.1' });
  await withProtectedHttpServer(passwordRuntime, async (origin) => {
    assert.equal(await httpStatus(origin, { authorization: basicAuth(password) }), 200);
    assert.equal(await httpStatus(`${origin}?password=${encodeURIComponent(password)}`), 200);
    assert.equal(
      await httpStatus(origin, {
        cookie: `farmslot_gateway_password=${encodeURIComponent(password)}`,
      }),
      200,
    );
    assert.equal(await httpStatus(origin, { authorization: `Bearer ${password}` }), 401);
    assert.equal(await httpStatus(`${origin}?token=${encodeURIComponent(password)}`), 401);
    assert.equal(
      await httpStatus(
        `${origin}?token=${encodeURIComponent(password)}&password=${encodeURIComponent(password)}`,
      ),
      401,
    );
  });
});

test('first non-admin issuance dual-mints an admin and never stores recoverable secrets', () => {
  const env = isolatedEnv();
  const runtime = new CredentialStoreRuntime(env);
  const writer = new CredentialStoreWriter(runtime);
  const operator = writer.createPrincipal({ type: 'person', displayName: 'sam' }, [
    { role: 'operator', scope: { kind: 'global' } },
  ]);
  const issue = writer.issueCredential(operator.id, 'sam-laptop');
  assert.equal(issue.activationLatched, true);
  assert.ok(issue.adminGrant, 'activation must atomically mint an owner admin');

  const store = runtime.snapshot();
  assert.ok(store.activatedAt);
  assert.equal(store.credentials.length, 2);
  const serialized = readFileSync(runtime.path, 'utf8');
  assert.equal(serialized.includes(issue.secret), false);
  assert.equal(serialized.includes(issue.adminGrant!.secret), false);
});

test('verification cache never caches authority and password transport stays legacy-only', () => {
  const env = isolatedEnv();
  const runtime = createGatewayAuthRuntime(env);
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  const principal = runtime.writer.createPrincipal({ type: 'person', displayName: 'sam' }, [
    { role: 'operator', scope: { kind: 'global' } },
  ]);
  const issued = runtime.writer.issueCredential(principal.id, 'sam-laptop');
  assert.equal(runtime.resolver.resolveSecret(issued.secret, 'token').ok, true);
  assert.equal(runtime.resolver.resolveSecret(issued.secret, 'password').ok, false);

  runtime.writer.grantRole(principal.id, 'admin', { kind: 'global' });
  const updated = runtime.resolver.resolveSecret(issued.secret, 'token');
  assert.equal(updated.ok, true);
  assert.equal(
    updated.ok && updated.principal.roles.some((binding) => binding.role === 'admin'),
    true,
  );
  runtime.writer.revokeCredential(issued.record.id);
  assert.deepEqual(runtime.resolver.resolveSecret(issued.secret, 'token'), {
    ok: false,
    reason: 'revoked',
  });
});

test('environment migration is additive and boot-secret resolution stays gateway-local', () => {
  const env = isolatedEnv({ FARMSLOT_GATEWAY_TOKEN: 'first-token' });
  const first = createGatewayAuthRuntime(env);
  initializeGatewayIdentity(first, { host: '127.0.0.1' });
  assert.equal(first.store.snapshot().credentials.length, 1);

  const messages: string[] = [];
  const changedEnv = { ...env, FARMSLOT_GATEWAY_TOKEN: 'second-token' };
  const second = createGatewayAuthRuntime(changedEnv);
  initializeGatewayIdentity(second, {
    host: '127.0.0.1',
    log: (message) => messages.push(message),
  });
  assert.equal(second.store.snapshot().credentials.length, 2);
  assert.equal(second.resolver.resolveSecret('first-token', 'token').ok, false);
  assert.equal(second.resolver.resolveSecret('second-token', 'token').ok, true);
  assert.ok(messages.some((message) => message.includes('does not remove access')));

  const unset = createGatewayAuthRuntime({
    FARMSLOT_HOME: env.FARMSLOT_HOME,
    GATEWAY_HOST: '127.0.0.1',
  });
  initializeGatewayIdentity(unset, { host: '127.0.0.1' });
  assert.equal(unset.store.snapshot().credentials.length, 2);
  assert.equal(unset.resolver.resolveSecret('first-token', 'token').ok, false);
  assert.equal(unset.resolver.resolveSecret('second-token', 'token').ok, false);

  const password = createGatewayAuthRuntime(
    isolatedEnv({ FARMSLOT_GATEWAY_PASSWORD: 'legacy-password' }),
  );
  initializeGatewayIdentity(password, { host: '127.0.0.1' });
  assert.equal(password.resolver.resolveSecret('legacy-password', 'password').ok, true);
  assert.equal(password.resolver.resolveSecret('legacy-password', 'token').ok, false);
});

test('last-admin refusal lives in both writer revoke primitives; offline recovery escapes it', () => {
  const env = isolatedEnv();
  const runtime = new CredentialStoreRuntime(env);
  const writer = new CredentialStoreWriter(runtime);
  const admin = writer.createPrincipal({ type: 'person', displayName: 'owner' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const issue = writer.issueCredential(admin.id, 'owner-laptop');
  assert.throws(
    () => writer.revokeCredential(issue.record.id),
    /last active admin credential[\s\S]*credential revoke <compromised-id> --offline[\s\S]*credential issue --principal owner --role admin --scope global --offline/u,
  );
  assert.throws(
    () => writer.revokeRole(admin.id, 'admin', { kind: 'global' }),
    /last active admin credential[\s\S]*Next: issue a replacement/u,
  );

  const offline = new CredentialStoreWriter(new CredentialStoreRuntime(env), true);
  assert.ok(offline.revokeCredential(issue.record.id).revokedAt);
});

test('activated gateways without an admin teach the offline escape without revealing others', () => {
  const env = isolatedEnv();
  const offline = new CredentialStoreWriter(new CredentialStoreRuntime(env), true);
  const operator = offline.createPrincipal({ type: 'person', displayName: 'sam' }, [
    { role: 'operator', scope: { kind: 'global' } },
  ]);
  const issue = offline.issueCredential(operator.id, 'sam-laptop');
  const runtime = createGatewayAuthRuntime(env);
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  const session = {
    authenticated: true,
    clientKind: 'ui' as const,
    authentication: { kind: 'credential' as const, credentialId: issue.record.id },
  };
  assert.throws(
    () => authorizeGatewayMethod(runtime, session, Methods.CREDENTIAL_ISSUE),
    (error: unknown) => {
      const denial = error as { message?: string; userAction?: string };
      assert.match(denial.message ?? '', /no active admin credential[\s\S]*principal 'sam'/u);
      assert.match(
        denial.userAction ?? '',
        /stop every gateway[\s\S]*credential issue --principal owner --role admin --scope global --offline/u,
      );
      assert.doesNotMatch(denial.message ?? '', /owner/u);
      return true;
    },
  );
});

test('offline reads and writes refuse every live gateway in the identity domain', () => {
  const env = isolatedEnv();
  const runtime = new CredentialStoreRuntime(env);
  const writer = new CredentialStoreWriter(runtime, true);
  const release = registerGatewayPresence(
    { pid: process.pid, farmslotRoot: '/tmp/farmslot-presence-proof', port: 7788 },
    env,
  );
  try {
    assert.throws(
      () => readCredentialStoreOffline(env),
      /\/tmp\/farmslot-presence-proof on port 7788/u,
    );
    assert.throws(
      () => writer.createPrincipal({ type: 'person', displayName: 'blocked' }, []),
      /stop them, then re-run/u,
    );
  } finally {
    release();
  }
  assert.deepEqual(readCredentialStoreOffline(env).principals, []);
});

test('solo activation is permanent for non-loopback bind and declared proxy trust', () => {
  for (const facts of [
    { host: '0.0.0.0', trust: false },
    { host: '127.0.0.1', trust: true },
  ]) {
    const env = isolatedEnv({
      ...(facts.trust ? { FARMSLOT_GATEWAY_TRUST_PROXY_HEADERS: '1' } : {}),
    });
    const runtime = createGatewayAuthRuntime(env);
    initializeGatewayIdentity(runtime, { host: facts.host });
    assert.equal(runtime.resolver.isSoloMode(), !facts.trust && facts.host === '127.0.0.1');
    assert.equal(latchActivationForExposure(runtime, facts.host), true);
    assert.equal(runtime.resolver.isSoloMode(), false);
    assert.equal(runtime.store.snapshot().activatedAt !== null, true);
  }
});

test('authorization is exactly the eight operator methods and separates node subjects', () => {
  const env = isolatedEnv();
  const runtime = newRuntimeWithIdentity(env);
  const operator = createCredentialSession(runtime, 'sam', [
    { role: 'operator', scope: { kind: 'global' } },
  ]);
  for (const method of operatorMethods) {
    assert.equal(
      authorizeGatewayMethod(runtime, operator.session, method).id,
      operator.principalId,
    );
  }
  for (const method of [
    Methods.PRINCIPAL_CREATE,
    Methods.PRINCIPAL_LIST,
    Methods.PRINCIPAL_GRANT,
    Methods.PRINCIPAL_REVOKE_ROLE,
    Methods.CREDENTIAL_ISSUE,
    Methods.CREDENTIAL_LIST,
    Methods.CREDENTIAL_REVOKE,
  ]) {
    assert.throws(() => authorizeGatewayMethod(runtime, operator.session, method));
  }
  assert.throws(
    () => authorizeGatewayMethod(runtime, operator.session, Methods.DISPATCH_QUEUE_ADD),
    /requires the admin role[\s\S]*principal 'sam'/u,
  );
  assert.throws(
    () => authorizeGatewayMethod(runtime, operator.session, Methods.BACKLOG_UPCOMING),
    /not on the proven-conformant allowlist/u,
  );

  const empty = createCredentialSession(runtime, 'empty', []);
  assert.throws(() => authorizeGatewayMethod(runtime, empty.session, Methods.RUN_LIST));

  const node = runtime.writer.createPrincipal(
    { type: 'node', displayName: 'node-a', machine: 'node-a' },
    [],
  );
  const nodeIssue = runtime.writer.issueCredential(node.id, 'node-a');
  const nodeSession = {
    authenticated: true,
    clientKind: 'node' as const,
    authentication: { kind: 'credential' as const, credentialId: nodeIssue.record.id },
  };
  assert.equal(isNodeSubjectSession(runtime, nodeSession), true);
  assert.equal(isNodeSubjectSession(runtime, operator.session), false);
  const resolveSessionPrincipal = runtime.resolver.resolveSessionPrincipal;
  runtime.resolver.resolveSessionPrincipal = () => {
    throw new Error('credential store read failed');
  };
  try {
    assert.throws(
      () => isNodeSubjectSession(runtime, nodeSession),
      /credential store read failed/u,
    );
  } finally {
    runtime.resolver.resolveSessionPrincipal = resolveSessionPrincipal;
  }
  assert.equal(authorizeGatewayMethod(runtime, nodeSession, 'node.connect').id, node.id);
  assert.throws(
    () => authorizeGatewayMethod(runtime, nodeSession, Methods.RUN_LIST),
    /node surface/u,
  );

  runtime.writer.revokeRole(operator.principalId, 'operator', { kind: 'global' });
  assert.throws(() => authorizeGatewayMethod(runtime, operator.session, Methods.RUN_LIST));
});

test('stored effects fail closed against live originator authority and name the item', () => {
  const env = isolatedEnv();
  const runtime = newRuntimeWithIdentity(env);
  const admin = createCredentialSession(runtime, 'queue-owner', [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const principal = runtime.resolver.resolvePrincipalId(admin.principalId);
  assert.equal(principal.ok, true);
  assert.equal(
    authorizeStoredRunEffect(
      principal.ok ? principal.principal : null,
      'critical-item',
      'dangerous',
    ).id,
    admin.principalId,
  );
  createCredentialSession(runtime, 'backup-owner', [{ role: 'admin', scope: { kind: 'global' } }]);
  runtime.writer.revokeRole(admin.principalId, 'admin', { kind: 'global' });
  const demoted = runtime.resolver.resolvePrincipalId(admin.principalId);
  assert.throws(
    () =>
      authorizeStoredRunEffect(demoted.ok ? demoted.principal : null, 'critical-item', 'dangerous'),
    /critical-item[\s\S]*no longer has admin\/global authority/u,
  );
  assert.throws(
    () => authorizeStoredRunEffect(null, 'corrupt-item', undefined),
    /corrupt-item[\s\S]*cannot be resolved/u,
  );
});

function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), 'farmslot-principal-core-'));
  return { ...extra, FARMSLOT_HOME: home, GATEWAY_HOST: '127.0.0.1' };
}

function newRuntimeWithIdentity(env: NodeJS.ProcessEnv) {
  const runtime = createGatewayAuthRuntime(env);
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  return runtime;
}

function createCredentialSession(
  runtime: ReturnType<typeof newRuntimeWithIdentity>,
  displayName: string,
  roles: Array<{
    role: 'admin' | 'operator';
    scope: { kind: 'global' };
  }>,
) {
  const principal = runtime.writer.createPrincipal({ type: 'person', displayName }, roles);
  const issue = runtime.writer.issueCredential(principal.id, `${displayName}-credential`);
  return {
    principalId: principal.id,
    session: {
      authenticated: true,
      clientKind: 'ui' as const,
      authentication: { kind: 'credential' as const, credentialId: issue.record.id },
    },
  };
}

function spawnEval(source: string, extraEnv: Record<string, string>) {
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    cwd: resolve(process.cwd()),
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function spawnPresenceWorker(params: {
  home: string;
  readyPath: string;
  goPath: string;
  registeredPath: string;
  stopPath: string;
  port: number;
}) {
  return spawnEval(
    `
      const { existsSync, writeFileSync } = await import('node:fs');
      const { registerGatewayPresence } = await import('@farmslot/credential-store');
      const wait = (path) => {
        while (!existsSync(path)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      };
      writeFileSync(process.env.PRESENCE_READY, 'ready');
      wait(process.env.PRESENCE_GO);
      const release = registerGatewayPresence(
        { pid: process.pid, farmslotRoot: '/presence-worker', port: Number(process.env.PRESENCE_PORT) },
        { FARMSLOT_HOME: process.env.PRESENCE_HOME },
      );
      writeFileSync(process.env.PRESENCE_REGISTERED, 'registered');
      wait(process.env.PRESENCE_STOP);
      release();
    `,
    {
      PRESENCE_HOME: params.home,
      PRESENCE_READY: params.readyPath,
      PRESENCE_GO: params.goPath,
      PRESENCE_REGISTERED: params.registeredPath,
      PRESENCE_STOP: params.stopPath,
      PRESENCE_PORT: String(params.port),
    },
  );
}

async function waitForChild(
  child: ReturnType<typeof spawn>,
  acceptedCodes: readonly (number | null)[] = [0],
): Promise<void> {
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });
  const code = await new Promise<number | null>((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('exit', resolvePromise);
  });
  assert.equal(
    acceptedCodes.includes(code),
    true,
    `child exited with ${String(code)}:\n${output.slice(-4_000)}`,
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to reserve test port');
  await new Promise<void>((resolvePromise, rejectPromise) =>
    server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
  );
  return address.port;
}

async function withProtectedHttpServer(
  runtime: ReturnType<typeof createGatewayAuthRuntime>,
  fn: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    if (!authorizeHttpRequest({ runtime, req, res })) return;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('protected resource');
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing HTTP test address');
  try {
    await fn(`http://127.0.0.1:${address.port}/api/run-artifact`);
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) =>
      server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
    );
  }
}

async function httpStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return (await fetch(url, { headers })).status;
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`:${password}`).toString('base64')}`;
}
