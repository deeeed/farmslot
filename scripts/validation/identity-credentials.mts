// Manual protocol proof. Uses an isolated identity home and service/node credentials only.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'identity-credentials-proof-'));
let cleanupServer: (() => Promise<void>) | undefined;
let releasePresence: (() => void) | undefined;
try {
  process.env.FARMSLOT_HOME = join(scratch, 'home');
  process.env.FARMSLOT_ROOT = scratch;
  for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
    const file = join(scratch, marker);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, marker.endsWith('json') ? '{}' : '');
  }
  await mkdir(join(scratch, 'bin'), { recursive: true });
  await writeFile(join(scratch, 'bin', 'tmux'), '#!/bin/sh\nexit 77\n', { mode: 0o700 });
  process.env.PATH = `${join(scratch, 'bin')}:${process.env.PATH}`;
  process.env.GATEWAY_HOST = '127.0.0.1';
  // A synthetic obsolete value must neither create identity nor authenticate.
  process.env.FARMSLOT_GATEWAY_TOKEN = 'obsolete-proof-value';
  delete process.env.FARMSLOT_GATEWAY_PASSWORD;

  const {
    CredentialStoreRuntime,
    CredentialStoreWriter,
    registerGatewayPresence,
    retirePrincipalsOffline,
  } = await import('@farmslot/credential-store');
  const { GatewayClient } = await import('../../packages/cli/src/gateway-client.js');
  const { createGatewayAuthRuntime, initializeGatewayIdentity, authorizeHttpRequest } =
    await import('../../services/gateway/src/security/auth.js');
  await writeFile(
    join(scratch, '.farm-status.json'),
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      slots: [],
      summary: {
        total: 0,
        ready: 0,
        busy: 0,
        held: 0,
        manual: 0,
        disabled: 0,
        blocked: 0,
        warmCount: 0,
      },
    }),
  );
  const { createWebSocketServer } = await import('../../services/gateway/src/server.js');

  const store = new CredentialStoreRuntime();
  const writer = new CredentialStoreWriter(store, true);
  writer.createPrincipal({ type: 'service', displayName: 'farm-automation' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const admin = writer.issueCredential('farm-automation', 'test-automation');
  const paired = writer.issueCredential('farm-automation', 'test-paired-device', 'paired');
  const revoked = writer.issueCredential('farm-automation', 'test-revoked-legacy');
  writer.revokeCredential(revoked.record.id);
  const expectedStore = structuredClone(store.snapshot());
  const historicalStore = {
    ...expectedStore,
    credentials: expectedStore.credentials.map((record) => ({
      ...record,
      origin:
        record.id === admin.record.id || record.id === revoked.record.id
          ? 'env-migrated'
          : record.origin,
    })),
  };
  await writeFile(store.path, JSON.stringify(historicalStore));
  const runtime = createGatewayAuthRuntime();
  assert.deepEqual(runtime.store.snapshot(), expectedStore);
  assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')), expectedStore);
  const migratedBytes = await readFile(store.path);
  const migratedStamp = await stat(store.path);
  createGatewayAuthRuntime();
  assert.deepEqual(await readFile(store.path), migratedBytes);
  assert.equal((await stat(store.path)).ino, migratedStamp.ino);
  assert.equal((await stat(store.path)).mtimeMs, migratedStamp.mtimeMs);
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  const httpServer = createServer((req, res) => {
    if (authorizeHttpRequest({ runtime, req, res, resource: 'file' })) {
      res.writeHead(204);
      res.end();
    }
  });
  const wss = createWebSocketServer(httpServer, runtime);
  cleanupServer = async () => {
    for (const connection of wss.clients) connection.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (httpServer.listening)
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
  };
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}`;
  releasePresence = registerGatewayPresence({
    pid: process.pid,
    farmslotRoot: scratch,
    port: address.port,
  });
  const client = new GatewayClient({ url, timeout: 5000, credential: { token: admin.secret } });
  const claims: string[] = [
    'historical origins migrate at boot with every other field preserved; repeat boot does not rewrite',
  ];
  const pairedClient = new GatewayClient({
    url,
    timeout: 5000,
    credential: { token: paired.secret },
  });
  await pairedClient.call('principal.list', {});
  const revokedClient = new GatewayClient({
    url,
    timeout: 5000,
    credential: { token: revoked.secret },
  });
  await assert.rejects(revokedClient.call('principal.list', {}));
  const rawHistorical = new GatewayClient({
    url,
    timeout: 5000,
    credential: { token: admin.secret.slice(admin.secret.indexOf('_', 3) + 1) },
  });
  await assert.rejects(rawHistorical.call('principal.list', {}));
  claims.push(
    'paired device credential survives; migrated revocations and raw-secret denial remain enforced',
  );
  const started = performance.now();

  const listed = await client.call<{ principals: Array<{ id: string }> }>('principal.list', {});
  assert.deepEqual(
    listed.principals.map((principal) => principal.id),
    ['farm-automation'],
  );
  claims.push('environment value creates no identity');
  await assert.rejects(
    client.call('run.adoptPublishedPr', {
      runId: 'absent-proof-run',
      prRef: 'https://github.com/example/proof/pull/1',
      headSha: 'a'.repeat(40),
      attestReviewedPublication: true,
      reason: 'service must not attest',
    }),
    { code: 'AUTH_FORBIDDEN' },
  );
  claims.push('service admin cannot attest to publication');
  const raw = new GatewayClient({
    url,
    timeout: 5000,
    credential: { token: 'obsolete-proof-value' },
  });
  await assert.rejects(raw.call('principal.list', {}));
  claims.push('raw environment-secret presentation denied');
  const missing = new GatewayClient({ url, timeout: 5000 });
  await assert.rejects(missing.call('principal.list', {}));
  claims.push('uncredentialed client does not discover environment secrets');

  const created = await client.call<{ principal: { id: string } }>('principal.create', {
    subject: { type: 'node', displayName: 'proof-node', machine: 'proof-machine' },
    roles: [],
  });
  const issued = await client.call<{ credential: { id: string }; secret: string }>(
    'credential.issue',
    {
      principalId: created.principal.id,
      displayName: 'proof-machine',
    },
  );
  const node = new GatewayClient({ url, timeout: 5000, credential: { token: issued.secret } });
  await assert.rejects(node.call('principal.list', {}), { code: 'AUTH_FORBIDDEN' });
  const deniedHttp = await fetch(`http://127.0.0.1:${address.port}/api/file`, {
    headers: { Authorization: `Bearer ${issued.secret}` },
  });
  assert.equal(deniedHttp.status, 403);
  claims.push('node credential cannot use person/service RPCs or HTTP files');
  await assert.rejects(client.call('principal.retire', { principalIds: [created.principal.id] }));
  claims.push('active credential prevents retirement');
  await client.call('credential.revoke', { credentialId: issued.credential.id });
  const retired = await client.call('principal.retire', { principalIds: [created.principal.id] });
  assert.deepEqual(retired, {
    principalIds: [created.principal.id],
    credentialIds: [issued.credential.id],
  });
  await assert.rejects(node.call('principal.list', {}));
  const replacement = await client.call<{ principal: { id: string } }>('principal.create', {
    subject: { type: 'node', displayName: 'proof-node', machine: 'proof-machine' },
    roles: [],
  });
  assert.notEqual(replacement.principal.id, created.principal.id);
  assert.ok(runtime.store.snapshot().activatedAt);
  claims.push('revocation and retirement take effect; ids and activation remain reserved');
  await client.call('credential.revoke', { credentialId: paired.record.id });
  await assert.rejects(client.call('credential.revoke', { credentialId: admin.record.id }));
  assert.throws(() => retirePrincipalsOffline([replacement.principal.id]), /gateway|stopped/i);
  claims.push('last admin and live-gateway offline guards refuse unsafe writes');
  const survivor = runtime.store.findCredential(admin.record.id);
  assert.equal(survivor?.revokedAt, null);
  console.log(
    JSON.stringify({ ok: true, claims, elapsedMs: performance.now() - started }, null, 2),
  );
} finally {
  releasePresence?.();
  try {
    await cleanupServer?.();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
