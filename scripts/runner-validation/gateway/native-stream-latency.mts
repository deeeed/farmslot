/**
 * Native stream latency probe. A synthetic Claude stream-json peer writes timestamped text deltas;
 * they pass through the real native host and an in-process gateway to UI clients. The probe
 * reports runner→client and host-journal→client latency and the gateway event-loop delay, with
 * optional fleet load (slot writes that rebroadcast `fleet.updated`) and extra viewers.
 * Isolated: temp FARMSLOT_HOME/root, never the operator gateway.
 *
 * node --import tsx scripts/runner-validation/gateway/native-stream-latency.mts \
 *   --out <dir> [--deltas 200] [--interval 20] [--viewers 3] [--load] [--status-file <json>]
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type {
  NativeSessionDeltaPayload,
  NativeSessionInfo,
  NativeSessionSubscribeResult,
} from '@farmslot/protocol';

interface StreamSamples {
  /** Fixture write → client receive, per streamed chunk. */
  runnerToClient: number[];
  /** Host journal append (`event.at`) → client receive, per text event. */
  hostToClient: number[];
  frames: number;
  bytes: number;
}
interface Percentiles {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(tmpdir(), 'native-stream-latency') },
    deltas: { type: 'string', default: '200' },
    interval: { type: 'string', default: '20' },
    viewers: { type: 'string', default: '0' },
    load: { type: 'boolean', default: false },
    'status-file': { type: 'string' },
    label: { type: 'string', default: 'run' },
  },
});
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.resolve(values.out);
const root = await mkdtemp(path.join(tmpdir(), 'native-stream-latency-'));
await mkdir(output, { recursive: true });
for (const directory of ['scripts', 'services/gateway', 'pool', 'projects', 'bin', 'claude'])
  await mkdir(path.join(root, directory), { recursive: true });
await mkdir(path.join(root, 'packages/agent-runtime'), { recursive: true });
fs.symlinkSync(
  path.join(repo, 'packages/agent-runtime/scripts'),
  path.join(root, 'packages/agent-runtime/scripts'),
  'dir',
);
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated native stream latency probe\n');
await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
const executable = path.join(root, 'bin/claude');
await copyFile(
  path.join(repo, 'scripts/runner-validation/fixtures/native-stream-latency-claude.cjs'),
  executable,
);
fs.chmodSync(executable, 0o700);

const statusFile = path.join(root, 'status.json');
if (values['status-file']) await copyFile(path.resolve(values['status-file']), statusFile);
else
  await writeFile(
    statusFile,
    JSON.stringify({ checkedAt: new Date().toISOString(), slots: [], summary: {} }),
  );
const status = JSON.parse(await readFile(statusFile, 'utf8')) as { slots: { slot: string }[] };
assert(!values.load || status.slots.length, '--load needs --status-file with at least one slot');
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({ machine: 'local', project: 'latency', host: 'localhost', slots: [] }),
);
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
  CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  NATIVE_LATENCY_DELTAS: values.deltas,
  NATIVE_LATENCY_INTERVAL_MS: values.interval,
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: statusFile,
});
delete process.env.CODEX_LB_API_KEY;

const { createGatewayAuthRuntime } = await import('../../../services/gateway/src/security/auth.js');
const { createWebSocketServer, initServerGlobals, resetServerGlobalsForTests } =
  await import('../../../services/gateway/src/server.js');
const { updateSlotStatus } = await import('../../../services/gateway/src/core/state.js');
const { GatewayClient } = await import('../../../packages/cli/src/gateway-client.js');
const { NativeSessionClient } =
  await import('../../../packages/agent-runtime/src/native/client.js');

const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME });
const roles = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
const owner = auth.writer.createPrincipal(
  { type: 'service', displayName: 'Latency probe' },
  roles,
  'latency-probe',
);
const person = auth.writer.createPrincipal(
  { type: 'person', displayName: 'Latency operator' },
  roles,
  'latency-operator',
);
const credential = auth.writer.issueCredential(person.id, 'Latency browser');
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
await new NativeSessionClient(path.join(root, 'native')).warm();

const server = createServer();
const wss = createWebSocketServer(server, auth);
initServerGlobals();
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const connect = async () => {
  const grant = auth.writer.exchangePersonCredential(credential.secret, {
    deviceName: 'Latency RPC',
    deviceKind: 'cli',
  });
  return new GatewayClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    credential: { token: grant.accessToken },
    timeout: 60_000,
  }).connect();
};
const connection = await connect();
const viewers = await Promise.all(Array.from({ length: Number(values.viewers) }, () => connect()));

const samples: StreamSamples = { runnerToClient: [], hostToClient: [], frames: 0, bytes: 0 };
let completed = false;
let subscriptionId: string | undefined;
const stopEvents = connection.onEvent((frame) => {
  if (frame.event !== 'native.session.delta') return;
  const received = Date.now();
  const payload = frame.payload as NativeSessionDeltaPayload;
  if (payload.subscriptionId !== subscriptionId) return;
  samples.frames++;
  samples.bytes += Buffer.byteLength(JSON.stringify(payload));
  if (payload.kind !== 'delta' && payload.kind !== 'replay') return;
  for (const event of payload.page.events) {
    if (event.type === 'turn.completed') completed = true;
    if (event.type !== 'text.delta' || !event.text) continue;
    samples.hostToClient.push(received - Date.parse(event.at));
    for (const match of event.text.matchAll(/\[t=(\d+)\]/g))
      samples.runnerToClient.push(received - Number(match[1]));
  }
});

const percentiles = (list: number[]): Percentiles => {
  const sorted = [...list].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
};
const until = async (check: () => boolean, description: string, timeout = 120_000) => {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, 'Timed out: ' + description);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

let session: NativeSessionInfo | undefined;
let load: ReturnType<typeof setInterval> | undefined;
const loop = monitorEventLoopDelay({ resolution: 10 });
const result: Record<string, unknown> = { label: values.label, root, args: values };
try {
  session = (
    (await connection.call('native.session.create', {
      runner: 'claude',
      model: 'haiku',
      cwd: root,
      executionNodeId: 'local',
      mode: 'default',
      approvalMode: 'ask',
    })) as { session: NativeSessionInfo }
  ).session;
  const selection = { sessionId: session.id, executionNodeId: 'local' };
  subscriptionId = (
    (await connection.call('native.session.subscribe', selection)) as NativeSessionSubscribeResult
  ).subscriptionId;
  for (const viewer of viewers) await viewer.call('native.session.subscribe', selection);
  if (values.load) {
    const slot = status.slots[0].slot;
    let tick = 0;
    load = setInterval(() => {
      void updateSlotStatus(slot, { latency_probe_tick: ++tick });
    }, 100);
  }
  loop.enable();
  const started = Date.now();
  await connection.call('native.session.send', {
    ...selection,
    commandId: crypto.randomUUID(),
    text: 'stream',
  });
  await until(() => completed, 'turn completion');
  loop.disable();
  result.wallMs = Date.now() - started;
  result.runnerToClientMs = percentiles(samples.runnerToClient);
  result.hostToClientMs = percentiles(samples.hostToClient);
  result.eventLoopDelayMs = {
    p50: loop.percentile(50) / 1e6,
    p99: loop.percentile(99) / 1e6,
    max: loop.max / 1e6,
  };
  result.frames = samples.frames;
  result.bytes = samples.bytes;
  result.gatewayPerformance = await connection.call('gateway.performance.get', {});
  result.pass = samples.runnerToClient.length === Number(values.deltas);
} finally {
  if (load) clearInterval(load);
  stopEvents();
  if (session)
    await connection.call('native.session.close', {
      sessionId: session.id,
      executionNodeId: 'local',
    });
  for (const viewer of viewers) viewer.close();
  connection.close();
  resetServerGlobalsForTests();
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const lock = path.join(root, 'native/lock/owner.json');
  if (fs.existsSync(lock)) {
    const supervisor = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number };
    const argv = execFileSync('ps', ['-p', String(supervisor.pid), '-o', 'command='], {
      encoding: 'utf8',
    });
    assert(argv.includes(path.join(root, 'native')));
    process.kill(supervisor.pid, 'SIGTERM');
    await until(
      () => !fs.existsSync(path.join(root, 'native/lock')),
      'private host cleanup',
      30_000,
    );
  }
  await writeFile(
    path.join(output, `${values.label}.json`),
    JSON.stringify(result, null, 2) + '\n',
  );
  const { gatewayPerformance: _omitted, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
}
