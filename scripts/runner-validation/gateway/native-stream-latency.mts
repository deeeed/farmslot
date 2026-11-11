/**
 * Native stream latency probe. A synthetic Claude stream-json peer writes timestamped text deltas;
 * they pass through the real native host and an in-process gateway to UI clients. The probe
 * reports runner→client and host-journal→client latency and the gateway event-loop delay, with
 * optional fleet load (slot writes that rebroadcast `fleet.updated`) and extra viewers.
 * Isolated: temp FARMSLOT_HOME/root, never the operator gateway.
 *
 * node --import tsx scripts/runner-validation/gateway/native-stream-latency.mts \
 *   --out <dir> [--deltas 200] [--interval 20] [--viewers 3] [--load] [--status-file <json>]
 *   [--write-interval <ms>] [--max-p95-ms <n>] [--max-loop-p99-ms <n>]
 * Exits non-zero when any viewer loses or reorders a delta, when runner→client p95 or event-loop
 * p99 exceeds its budget, or (with --load) when fleet broadcasts stall, burst past the 250 ms rate
 * limit, or never carry the final committed slot state.
 * Without --status-file, --load uses 60 synthetic slot rows; pass a copy of a real
 * `.farm-status.json` for a production-sized fleet (keep it out of git).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  /** Fixture line numbers in arrival order; a lost or reordered delta breaks 0..n-1. */
  lines: number[];
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
    'write-interval': { type: 'string', default: '100' },
    'status-file': { type: 'string' },
    'max-p95-ms': { type: 'string' },
    'max-loop-p99-ms': { type: 'string' },
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
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      slots: Array.from({ length: values.load ? 60 : 0 }, (_, index) => ({
        slot: `latency-${index}`,
        machine: 'local',
        project: 'latency',
        platform: 'cli',
        lifecycle: index % 3 ? 'ready' : 'busy',
        branch: `perf/latency-${index}`,
        session: `latency-${index}`,
        repo: path.join(root, 'checkouts', String(index)),
      })),
      summary: {},
    }),
  );
const status = JSON.parse(await readFile(statusFile, 'utf8')) as { slots: { slot: string }[] };
assert(!values.load || status.slots.length, '--load needs at least one slot row');
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
const samples: StreamSamples = {
  runnerToClient: [],
  hostToClient: [],
  lines: [],
  frames: 0,
  bytes: 0,
};
/** Fixture line numbers each extra viewer received, by its subscription. */
const viewerLines = new Map<string, number[]>();
const onViewerFrame = (frame: { event: string; payload: unknown }) => {
  if (frame.event !== 'native.session.delta') return;
  const payload = frame.payload as NativeSessionDeltaPayload;
  const lines = viewerLines.get(payload.subscriptionId);
  if (!lines || (payload.kind !== 'delta' && payload.kind !== 'replay')) return;
  for (const event of payload.page.events)
    if (event.type === 'text.delta' && event.text)
      for (const match of event.text.matchAll(/\[t=\d+\] line (\d+) /g))
        lines.push(Number(match[1]));
};
/** `fleet.updated` arrivals and the load slot's branch in each, to prove writes reach clients. */
interface FleetBroadcast {
  at: number;
  branch?: string;
}
const fleetBroadcasts: FleetBroadcast[] = [];
const loadSlot = status.slots[0]?.slot;
let completed = false;
let subscriptionId: string | undefined;
const onFrame = (frame: { event: string; payload: unknown }) => {
  if (frame.event === 'fleet.updated') {
    const { fleet } = frame.payload as { fleet: { slots: { slot: string; branch: string }[] } };
    fleetBroadcasts.push({
      at: Date.now(),
      branch: fleet.slots.find((row) => row.slot === loadSlot)?.branch,
    });
  }
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
    for (const match of event.text.matchAll(/\[t=(\d+)\] line (\d+) /g)) {
      samples.runnerToClient.push(received - Number(match[1]));
      samples.lines.push(Number(match[2]));
    }
  }
};

const percentiles = (list: number[]): Percentiles => {
  const sorted = [...list].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
};
// A recipe timeout or Ctrl-C stops the run at its next checkpoint; the run then settles and the
// same teardown as a failure stops everything it acquired.
let interruptedBy: NodeJS.Signals | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    interruptedBy ??= signal;
  });
const checkpoint = () => {
  if (interruptedBy) throw new Error(`Interrupted by ${interruptedBy}`);
};
interface UntilOptions {
  timeout?: number;
  /** Teardown waits must finish even after a signal. */
  interruptible?: boolean;
}
const until = async (
  check: () => boolean,
  description: string,
  { timeout = 120_000, interruptible = true }: UntilOptions = {},
) => {
  const end = Date.now() + timeout;
  while (!check()) {
    if (interruptible) checkpoint();
    assert.ok(Date.now() < end, 'Timed out: ' + description);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

let session: NativeSessionInfo | undefined;
let load: ReturnType<typeof setInterval> | undefined;
let server: ReturnType<typeof createServer> | undefined;
let wss: ReturnType<typeof createWebSocketServer> | undefined;
let connection: Awaited<ReturnType<InstanceType<typeof GatewayClient>['connect']>> | undefined;
let stopEvents: (() => void) | undefined;
const viewers: NonNullable<typeof connection>[] = [];
const loop = monitorEventLoopDelay({ resolution: 10 });
const result: Record<string, unknown> = { label: values.label, root, args: values };
let runError: unknown;
const run = async () => {
  await new NativeSessionClient(path.join(root, 'native')).warm();
  checkpoint();
  server = createServer();
  wss = createWebSocketServer(server, auth);
  initServerGlobals();
  const listening = server;
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
  checkpoint();
  const address = listening.address();
  assert(address && typeof address !== 'string');
  const connect = async () => {
    const grant = await auth.writer.exchangePersonCredential(credential.secret, {
      deviceName: 'Latency RPC',
      deviceKind: 'cli',
    });
    return new GatewayClient({
      url: `ws://127.0.0.1:${address.port}/ws`,
      credential: { token: grant.accessToken },
      timeout: 60_000,
    }).connect();
  };
  connection = await connect();
  checkpoint();
  for (let index = 0; index < Number(values.viewers); index++) {
    viewers.push(await connect());
    checkpoint();
  }
  stopEvents = connection.onEvent(onFrame);
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
  const stopViewerEvents = viewers.map((viewer) => viewer.onEvent(onViewerFrame));
  for (const viewer of viewers) {
    const subscribed = (await viewer.call(
      'native.session.subscribe',
      selection,
    )) as NativeSessionSubscribeResult;
    viewerLines.set(subscribed.subscriptionId, []);
  }
  let lastBranch = '';
  let firstWriteAt = 0;
  let lastWriteAt = 0;
  if (values.load) {
    let tick = 0;
    firstWriteAt = Date.now();
    load = setInterval(() => {
      lastWriteAt = Date.now();
      lastBranch = `perf/latency-tick-${++tick}`;
      void updateSlotStatus(loadSlot, { branch: lastBranch });
    }, Number(values['write-interval']));
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
  if (load) {
    clearInterval(load);
    load = undefined;
    // The last write's broadcast is due within one rate-limit window and carries its state.
    const finalBranch = lastBranch;
    await until(
      () => fleetBroadcasts.some((broadcast) => broadcast.branch === finalBranch),
      'final committed fleet state',
      { timeout: 5_000 },
    );
  }
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
  const runnerToClient = result.runnerToClientMs as Percentiles;
  for (const stop of stopViewerEvents) stop();
  const complete = (lines: number[]) =>
    lines.length === Number(values.deltas) && lines.every((line, index) => line === index);
  const inOrder = complete(samples.lines) && [...viewerLines.values()].every(complete);
  const budget = values['max-p95-ms'] === undefined ? Infinity : Number(values['max-p95-ms']);
  const loopBudget =
    values['max-loop-p99-ms'] === undefined ? Infinity : Number(values['max-loop-p99-ms']);
  // However often slots are written, broadcasts go out at most once per 250 ms and never stop
  // while writes continue. Receive jitter can move one arrival, so cadence is checked per 1 s
  // window (at most 6: four at the rate limit plus jitter; the old 50 ms debounce sent about 10
  // under 100 ms writes) and as the longest silence while writes ran (at most 1 s; the debounce
  // sent nothing at all under 20 ms writes).
  const during = fleetBroadcasts
    .map((broadcast) => broadcast.at)
    .filter((at) => at >= firstWriteAt && at <= lastWriteAt + 300);
  const busiestSecond = Math.max(
    0,
    ...during.map((start) => during.filter((at) => at >= start && at < start + 1000).length),
  );
  const longestSilence = Math.max(
    0,
    ...[firstWriteAt, ...during, lastWriteAt].slice(1).map((at, index, list) => {
      const previous = index === 0 ? firstWriteAt : list[index - 1];
      return at - previous;
    }),
  );
  result.fleetBroadcasts = fleetBroadcasts.length;
  result.fleetBusiestSecond = values.load ? busiestSecond : null;
  result.fleetLongestSilenceMs = values.load ? longestSilence : null;
  result.inOrder = inOrder;
  result.viewersChecked = viewerLines.size;
  result.withinBudget =
    runnerToClient.p95 <= budget && (result.eventLoopDelayMs as { p99: number }).p99 <= loopBudget;
  result.fleetDelivered =
    !values.load ||
    (fleetBroadcasts.some((broadcast) => broadcast.branch === lastBranch) &&
      busiestSecond <= 6 &&
      longestSilence <= 1000);
  result.pass = inOrder && result.withinBudget && result.fleetDelivered;
};
try {
  // Awaited in full, never raced: teardown must see everything the run acquired.
  await run();
} catch (error) {
  runError = error;
} finally {
  // Every step runs even when an earlier one fails; failures are rethrown together below.
  const teardownErrors: unknown[] = [];
  const step = async (action: () => unknown) => {
    try {
      await action();
    } catch (error) {
      teardownErrors.push(error);
    }
  };
  if (load) clearInterval(load);
  stopEvents?.();
  await step(async () => {
    if (session && connection)
      await connection.call('native.session.close', {
        sessionId: session.id,
        executionNodeId: 'local',
      });
  });
  for (const viewer of viewers) await step(() => viewer.close());
  await step(() => connection?.close());
  await step(() => resetServerGlobalsForTests());
  await step(async () => {
    const sockets = wss;
    if (!sockets) return;
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  });
  await step(async () => {
    const listening = server;
    if (listening?.listening)
      await new Promise<void>((resolve) => listening.close(() => resolve()));
  });
  await step(async () => {
    const lock = path.join(root, 'native/lock/owner.json');
    if (!fs.existsSync(lock)) return;
    const supervisor = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number };
    const argv = execFileSync('ps', ['-p', String(supervisor.pid), '-o', 'command='], {
      encoding: 'utf8',
    });
    assert(argv.includes(path.join(root, 'native')));
    process.kill(supervisor.pid, 'SIGTERM');
    await until(() => !fs.existsSync(path.join(root, 'native/lock')), 'private host cleanup', {
      timeout: 30_000,
      interruptible: false,
    });
  });
  await writeFile(
    path.join(output, `${values.label}.json`),
    JSON.stringify(result, null, 2) + '\n',
  );
  const { gatewayPerformance: _omitted, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
  if (result.pass !== true || teardownErrors.length || runError !== undefined) process.exitCode = 1;
  // Keep the private root (credentials, native journals) only when a failure needs inspecting.
  else await rm(root, { recursive: true, force: true });
  // The run's own failure stays first; teardown failures are added, never substituted.
  if (teardownErrors.length)
    throw new AggregateError(
      runError === undefined ? teardownErrors : [runError, ...teardownErrors],
      'Probe teardown failed',
    );
  if (runError !== undefined) throw runError;
}
