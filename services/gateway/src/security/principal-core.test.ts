import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { Methods } from '@farmslot/protocol';

import {
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
} from './credential-store.js';
import { CredentialStoreWriter, readCredentialStoreOffline } from './credential-store-writer.js';
import { registerGatewayPresence } from './gateway-presence.js';

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
    /last active admin credential[\s\S]*Next: issue a replacement[\s\S]*compromised-id/u,
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
        /stop every gateway[\s\S]*credential issue --principal owner --role admin --scope global/u,
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
