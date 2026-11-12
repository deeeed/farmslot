// Manual copy-only benchmark. Never pass an operator home or print credential contents.
// Prepare a private directory (0700), copy credentials.json there (0600), and add
// copy-origin.json containing {"source":"<absolute original credential path>"}.
// One synthetic service credential/token is added ONLY to the copy. Keep that
// prepared copy for both versions, then delete it; output contains metrics only.
// TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx
// --experimental-test-module-mocks services/gateway/src/security/credential-stamp-benchmark.live.ts
// --credential-copy <private-copy>/credentials.json --output <metrics.json>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { mock } from 'node:test';
import { parseArgs } from 'node:util';

import type { GatewayConnection } from '../../../../packages/cli/src/gateway-client.js';

const { values } = parseArgs({
  options: { 'credential-copy': { type: 'string' }, output: { type: 'string' } },
});
assert(values['credential-copy'] && values.output);
const credentialPath = fs.realpathSync(values['credential-copy']);
assert.equal(path.basename(credentialPath), 'credentials.json');
const home = path.dirname(credentialPath);
const origin: unknown = JSON.parse(await readFile(path.join(home, 'copy-origin.json'), 'utf8'));
assert(
  origin && typeof origin === 'object' && 'source' in origin && typeof origin.source === 'string',
);
assert.notEqual(credentialPath, fs.realpathSync(origin.source), 'Refuse operator state');
const root = await mkdtemp(path.join(tmpdir(), 'credential-stamp-benchmark-'));
const connections: GatewayConnection[] = [];
const broadcastCleanups = new Set<() => void>();
let closeServer = async () => {};
let restore = () => {};
try {
  Object.assign(process.env, {
    NODE_TEST_CONTEXT: '1',
    FARMSLOT_TEST_TMP: '1',
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: home,
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
  });
  await Promise.all(['runs', 'projects', 'pool'].map((dir) => mkdir(path.join(root, dir))));
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, 'services/gateway'), { recursive: true });
  await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated credential benchmark\n');
  await writeFile(path.join(root, 'scripts/dev.sh'), '# Not executed by this benchmark\n');
  await writeFile(
    path.join(root, 'services/gateway/package.json'),
    JSON.stringify({ name: '@farmslot/gateway', version: '0.0.0' }),
  );
  await import('../runtime/mock-pty.test-support.js');
  const { Methods } = await import('@farmslot/protocol');
  const { createGatewayAuthRuntime, initializeGatewayIdentity } = await import('./auth.js');
  const { createWebSocketServer, broadcastEvent, resetServerGlobalsForTests } =
    await import('../server.js');
  const { GatewayClient } = await import('../../../../packages/cli/src/gateway-client.js');
  const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home, GATEWAY_HOST: '127.0.0.1' });
  assert.equal(runtime.store.path, credentialPath);
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  const tokenFile = path.join(home, 'benchmark-token');
  if (!fs.existsSync(tokenFile)) {
    const principal = runtime.writer.createPrincipal(
      { type: 'service', displayName: 'credential-stamp-benchmark' },
      [{ role: 'operator', scope: { kind: 'global' } }],
    );
    const issued = runtime.writer.issueCredential(principal.id, 'isolated-benchmark');
    await writeFile(tokenFile, issued.secret, { mode: 0o600 });
    await chmod(tokenFile, 0o600);
  }
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const http = createServer();
  const wss = createWebSocketServer(http, runtime);
  closeServer = async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
    resetServerGlobalsForTests();
  };
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert(address && typeof address !== 'string');
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${address.port}`,
    credential: { token },
    timeout: 10_000,
  });
  for (let n = 0; n < 10; n++) connections.push(await client.connect());
  let stats = 0;
  const stat = fs.statSync;
  const resolvePrincipal = runtime.resolver.resolveSessionPrincipal.bind(runtime.resolver);
  const samples: number[] = [];
  const statSpy = mock.method(fs, 'statSync', (...args: Parameters<typeof stat>) => {
    if (String(args[0]) === credentialPath) stats++;
    return stat(...args);
  });
  syncBuiltinESMExports();
  runtime.resolver.resolveSessionPrincipal = (session) => {
    const started = performance.now();
    try {
      return resolvePrincipal(session);
    } finally {
      samples.push(performance.now() - started);
    }
  };
  restore = () => {
    statSpy.mock.restore();
    syncBuiltinESMExports();
    runtime.resolver.resolveSessionPrincipal = resolvePrincipal;
  };
  const summarize = (elapsedMs: number) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      statSyncCalls: stats,
      authorizationResolutions: samples.length,
      elapsedMs,
      medianAuthorizationMs: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
      p99AuthorizationMs:
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0,
    };
  };
  let started = performance.now();
  for (let n = 0; n < 100; n++) await connections[0]!.call(Methods.NODES_LIST, {});
  const rpc = summarize(performance.now() - started);
  stats = 0;
  samples.length = 0;
  const event = 'node.health.credential-stamp-benchmark';
  const deliveries = connections.map(
    (connection) =>
      new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          cleanup();
          reject(new Error('Benchmark broadcast did not reach every connection'));
        }, 2_000);
        const unsubscribe = connection.onEvent((frame) => {
          if (frame.event === event) {
            cleanup();
            resolve();
          }
        });
        const cleanup = () => {
          clearTimeout(deadline);
          unsubscribe();
          broadcastCleanups.delete(cleanup);
        };
        broadcastCleanups.add(cleanup);
      }),
  );
  started = performance.now();
  broadcastEvent(event, { benchmark: true });
  await Promise.all(deliveries);
  const broadcast = summarize(performance.now() - started);
  const result = {
    node: process.version,
    copyBytes: fs.statSync(credentialPath).size,
    rpc: { requests: 100, connections: 1, ...rpc },
    broadcast: { events: 1, connections: 10, deliveries: 10, ...broadcast },
  };
  await writeFile(values.output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally {
  for (const cleanup of broadcastCleanups) cleanup();
  restore();
  for (const connection of connections) connection.close();
  await closeServer();
  await rm(root, { recursive: true, force: true });
}
