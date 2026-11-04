import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGatewayAuthRuntime, initializeGatewayIdentity } from '../security/auth.js';

import { gatewayPerformance } from './performance.js';
import { servePerformanceMetrics } from './performance-http.js';

test('metrics refuses unauthenticated and operator readers and exports the Doctor collector for admin', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'performance-http-'));
  const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home, GATEWAY_HOST: '127.0.0.1' });
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  const admin = runtime.writer.createPrincipal({ type: 'service', displayName: 'fixture owner' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const adminCredential = runtime.writer.issueCredential(admin.id, 'performance test');
  const operator = runtime.writer.createPrincipal(
    { type: 'service', displayName: 'fixture operator' },
    [{ role: 'operator', scope: { kind: 'global' } }],
  );
  const operatorCredential = runtime.writer.issueCredential(
    operator.id,
    'performance operator test',
  );
  const server = createServer((req, res) => servePerformanceMetrics(req, res, runtime));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/metrics`;
  try {
    gatewayPerformance.observe('farmslot_rpc_duration_seconds', { method: 'fleet.status' }, 0.01);
    const denied = await fetch(url);
    assert.equal(denied.status, 401);
    assert.doesNotMatch(await denied.text(), /farmslot_rpc/);
    const forbidden = await fetch(url, {
      headers: { Authorization: `Bearer ${operatorCredential.secret}` },
    });
    assert.equal(forbidden.status, 403);
    const allowed = await fetch(url, {
      headers: { Authorization: `Bearer ${adminCredential.secret}` },
    });
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get('content-type') ?? '', /text\/plain/);
    assert.match(
      await allowed.text(),
      /farmslot_rpc_duration_seconds_count.*method="fleet.status"/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(home, { recursive: true, force: true });
  }
});
