import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleanupOnExit,
  startIsolatedStack,
  startReaper,
  stopProcess,
} from '../lib/isolated-stack.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
assert(process.argv[2], 'Pass a new private evidence directory');
const evidence = path.resolve(process.argv[2]);
await mkdir(path.dirname(evidence), { recursive: true });
await mkdir(evidence, { mode: 0o700 });
const fixture = await mkdtemp(path.join(os.tmpdir(), 'http-route-proof-'));
const reaper = startReaper();
reaper.path(fixture);
const parts = {};
const cleanup = cleanupOnExit(async () => {
  const results = await Promise.allSettled([parts.connection?.close(), stopProcess(parts.gateway)]);
  await rm(fixture, { recursive: true, force: true });
  reaper.done();
  const errors = results.filter((result) => result.status === 'rejected');
  if (errors.length)
    throw new AggregateError(
      errors.map((result) => result.reason),
      'Proof cleanup failed',
    );
});
try {
  for (const directory of ['home', 'pool', 'projects', 'runs', 'tmux', 'services/gateway'])
    await mkdir(path.join(fixture, directory), { recursive: true });
  await writeFile(
    path.join(fixture, 'package.json'),
    JSON.stringify({ name: 'farmslot', private: true }),
  );
  await writeFile(path.join(fixture, 'services/gateway/package.json'), '{}');
  await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated HTTP metrics proof\n');
  for (const directory of ['scripts', 'packages'])
    await symlink(path.join(root, directory), path.join(fixture, directory));
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.startsWith('FARMSLOT_') ||
      ['TMUX', 'TMUX_PANE', 'GATEWAY_URL', 'GATEWAY_PORT'].includes(key)
    )
      delete env[key];
  Object.assign(env, {
    TSX_TSCONFIG_PATH: path.join(root, 'services/gateway/tsconfig.json'),
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    FARMSLOT_NATIVE_STATE_DIR: path.join(fixture, 'native'),
    FARMSLOT_CAPABILITY_STORE_FILE: path.join(fixture, 'capabilities.json'),
    TMUX_TMPDIR: path.join(fixture, 'tmux'),
    LITELLM_API_KEY: '',
    LITELLM_URL: '',
    LITELLM_BASE_URL: '',
  });
  const { connection, port, token } = await startIsolatedStack(
    { root, evidence, env, fixture, reaper },
    parts,
  );
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${token}` };
  const requests = [];
  async function request(url, options, expected) {
    const response = await fetch(base + url, { signal: AbortSignal.timeout(5000), ...options });
    const text = await response.text();
    assert.equal(response.status, expected);
    requests.push({ status: response.status });
    return text;
  }
  await request('/health', {}, 200);
  await request('/api/run-artifact?path=private-marker', { method: 'OPTIONS' }, 204);
  await request('/api/run-artifact?path=private-marker', {}, 401);
  await request(
    '/api/run-artifact?runId=00000000-0000-0000-0000-000000000000&path=private-marker',
    { headers },
    404,
  );
  await request('/api/file?path=private-marker', { headers }, 400);
  await request('/unknown-private-marker', { method: 'POST' }, 404);
  const refused = await request('/metrics', {}, 401);
  assert.doesNotMatch(refused, /farmslot_http/);
  await request('/metrics', { headers }, 200);
  const exported = await request('/metrics', { headers }, 200);
  assert.equal(exported.includes(token), false, 'metrics must not expose credentials');
  assert.doesNotMatch(exported, /private-marker|00000000-0000-0000-0000-000000000000/);
  const snapshot = await connection.call('gateway.performance.get', {});
  const counters = snapshot.counters.filter((row) => row.name === 'farmslot_http_requests_total');
  for (const [method, status, count] of [
    ['http.health', '2xx', 1],
    ['http.options', '2xx', 1],
    ['http.run-artifact', '4xx', 2],
    ['http.file', '4xx', 1],
    ['http.other', '4xx', 1],
    ['http.metrics', '4xx', 1],
    ['http.metrics', '2xx', 2],
  ])
    assert.equal(
      counters.find((row) => row.labels.method === method && row.labels.status_class === status)
        ?.value,
      count,
      `${method} ${status}`,
    );
  assert.equal(
    snapshot.histograms.find(
      (row) =>
        row.name === 'farmslot_http_duration_seconds' && row.labels.method === 'http.run-artifact',
    )?.count,
    2,
  );
  assert.ok(
    snapshot.histograms
      .filter((row) => row.name === 'farmslot_http_duration_seconds')
      .every((row) => row.labels.action_class === undefined),
  );
  assert.match(exported, /farmslot_http_requests_total.*method="http.run-artifact"/);
  await writeFile(path.join(evidence, 'metrics.prom'), exported);
  await writeFile(
    path.join(evidence, 'result.json'),
    JSON.stringify(
      {
        requests,
        counters,
        durations: snapshot.histograms.filter(
          (row) => row.name === 'farmslot_http_duration_seconds',
        ),
        authenticatedRpcReadback: true,
        operatorWrites: 0,
        fixtureOnly: true,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: authenticated HTTP and RPC readbacks agree on bounded route counts and durations',
  );
} finally {
  await cleanup();
}
