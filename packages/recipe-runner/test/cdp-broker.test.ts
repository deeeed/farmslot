import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// ── Type declarations ────────────────────────────────────────────────────────

interface SessionInfo {
  deviceId: string;
  name: string;
  opened: boolean;
  brokerReady: boolean;
}

interface BrokerClient {
  close(): void;
  control(command: string, params?: Record<string, unknown>): Promise<unknown>;
  send(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}

interface Broker {
  close(): void;
  onSessionOpen(deviceId: string): void;
  onSessionClose(deviceId: string): void;
  onCdpEvent(deviceId: string, event: string, params: unknown): void;
}

type BrokerModule = {
  brokerSocketPath: (runtimeDir?: string, identity?: string | number) => string;
  createBrokerClient: (
    socketPath: string,
    deviceId: string,
    timeoutMs: number,
  ) => Promise<BrokerClient>;
  createCdpBroker: (options: {
    socketPath: string;
    sessions: Map<string, SessionInfo>;
    sendCommand: ReturnType<typeof mock.fn>;
    onClientActivity?: ReturnType<typeof mock.fn>;
    requestDiscovery?: ReturnType<typeof mock.fn>;
  }) => Broker;
};

type ConfigModule = {
  resolvePort: (env?: Record<string, string | undefined>, appRoot?: string) => string;
};

const brokerModule = require(
  fileURLToPath(new URL('../cdp-broker/cdp-broker.cjs', import.meta.url)),
) as BrokerModule;

const configModule = require(
  fileURLToPath(new URL('../../adapter-rn/bridge-runtime/lib/config.cjs', import.meta.url)),
) as ConfigModule;

const { brokerSocketPath, createBrokerClient, createCdpBroker } = brokerModule;
const { resolvePort } = configModule;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function waitFor(predicate: () => void | Promise<void>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await predicate();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError ?? new Error('waitFor timed out');
}

function matchesObject(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((e, i) => matchesObject((actual as unknown[])[i], e));
  }
  if (actual === null || typeof actual !== 'object') return false;
  const rec = actual as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
    if (!matchesObject(rec[k], v)) return false;
  }
  return true;
}

function assertMatchesObject(actual: unknown, expected: unknown, message?: string): void {
  assert.ok(
    matchesObject(actual, expected),
    message ?? `Expected ${JSON.stringify(actual)} to match ${JSON.stringify(expected)}`,
  );
}

// ── Setup helpers ────────────────────────────────────────────────────────────

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  mock.restoreAll();
  while (cleanups.length > 0) await cleanups.pop()!();
});

interface SetupOptions {
  directory?: string;
  socketPath?: string;
  sendCommand?: ReturnType<typeof mock.fn>;
  onClientActivity?: ReturnType<typeof mock.fn>;
  requestDiscovery?: ReturnType<typeof mock.fn>;
}

interface SetupResult {
  broker: Broker;
  client: BrokerClient;
  sendCommand: ReturnType<typeof mock.fn>;
  sessions: Map<string, SessionInfo>;
  socketPath: string;
}

async function setup(options: SetupOptions = {}): Promise<SetupResult> {
  const directory = options.directory ?? (await mkdtemp(path.join(os.tmpdir(), 'cdp-broker-')));
  const socketPath = options.socketPath ?? path.join(directory, 'broker.sock');
  const deviceId = 'device-1';
  const sessions = new Map<string, SessionInfo>([
    [deviceId, { deviceId, name: 'mmdev-1', opened: true, brokerReady: true }],
  ]);
  const sendCommand = options.sendCommand ?? mock.fn(async () => ({}));
  const broker = createCdpBroker({
    socketPath,
    sessions,
    sendCommand,
    onClientActivity: options.onClientActivity,
    requestDiscovery: options.requestDiscovery,
  });
  const client = await createBrokerClient(socketPath, deviceId, 1000);
  cleanups.push(async () => {
    client.close();
    broker.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { broker, client, sendCommand, sessions, socketPath };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CDP broker network capture', () => {
  it('uses a short stable per-runtime socket path', () => {
    const first = brokerSocketPath(`/private/${'deep/'.repeat(40)}runtime-a`);
    const second = brokerSocketPath(`/private/${'deep/'.repeat(40)}runtime-b`);

    assert.ok(Buffer.byteLength(first) < 100, `socket path too long: ${Buffer.byteLength(first)}`);
    assert.notEqual(first, second);
    assert.equal(first, brokerSocketPath(`/private/${'deep/'.repeat(40)}runtime-a`));
  });

  it('isolates Mobile brokers in one runtime directory by Metro port', () => {
    const runtimeDir = `/private/${'deep/'.repeat(40)}runtime-a`;

    assert.notEqual(brokerSocketPath(runtimeDir, 8061), brokerSocketPath(runtimeDir, 8161));
    assert.equal(brokerSocketPath(runtimeDir, 8061), brokerSocketPath(runtimeDir, '8061'));
  });

  it('resolves one producer/consumer port identity from env, .js.env, or 8081', async () => {
    const appRoot = await mkdtemp(path.join(os.tmpdir(), 'cdp-port-'));
    cleanups.push(() => rm(appRoot, { recursive: true, force: true }));

    assert.equal(resolvePort({}, appRoot), '8081');
    await writeFile(path.join(appRoot, '.js.env'), 'export WATCHER_PORT="8161"\n');
    assert.equal(resolvePort({}, appRoot), '8161');
    assert.equal(resolvePort({ METRO_PORT: '8261' }, appRoot), '8261');
    assert.equal(resolvePort({ WATCHER_PORT: '8361' }, appRoot), '8361');
  });

  it('lists active targets for zero-spawn run observers', async () => {
    const { client } = await setup();

    const result = await client.control('list-targets');
    assert.deepEqual(result, [{ deviceId: 'device-1', name: 'mmdev-1' }]);
  });

  it('preserves ambiguity when two live devices have the same display name', async () => {
    const { broker, client, sessions } = await setup();
    sessions.set('device-2', {
      deviceId: 'device-2',
      name: 'mmdev-1',
      opened: true,
      brokerReady: true,
    });
    broker.onSessionOpen('device-2');

    const result = await client.control('resolve-targets', { nameIncludes: 'mmdev-1' });
    assert.ok(Array.isArray(result) && result.length === 2, 'expected 2 targets');
    assertMatchesObject(result, [
      { deviceId: 'device-1', ready: true },
      { deviceId: 'device-2', ready: true },
    ]);
  });

  it('lists only ready target identities with their broker generation', async () => {
    const { broker, client, sessions } = await setup();

    assert.deepEqual(await client.control('list-target-identities'), [
      { deviceId: 'device-1', generation: 1, name: 'mmdev-1' },
    ]);

    sessions.delete('device-1');
    broker.onSessionClose('device-1');
    assert.deepEqual(await client.control('list-target-identities'), []);

    sessions.set('device-1', {
      deviceId: 'device-1',
      name: 'mmdev-1',
      opened: true,
      brokerReady: true,
    });
    broker.onSessionOpen('device-1');
    assert.deepEqual(await client.control('list-target-identities'), [
      { deviceId: 'device-1', generation: 2, name: 'mmdev-1' },
    ]);

    broker.onCdpEvent('device-1', 'Runtime.executionContextsCleared', {});
    broker.onCdpEvent('device-1', 'Runtime.executionContextCreated', { context: { id: 4 } });
    assert.deepEqual(await client.control('list-target-identities'), [
      { deviceId: 'device-1', generation: 3, name: 'mmdev-1' },
    ]);
    // Re-enabling Runtime replays creation without resetting the runtime.
    broker.onCdpEvent('device-1', 'Runtime.executionContextCreated', { context: { id: 4 } });
    assert.deepEqual(await client.control('list-target-identities'), [
      { deviceId: 'device-1', generation: 3, name: 'mmdev-1' },
    ]);
  });

  // 'reads the selected ready target identity without attaching to CDP'
  // → stays in mm-harness: requires cdp-bridge.cjs via runBridge

  // 'returns status with the ready target generation'
  // → stays in mm-harness: requires cdp-bridge.cjs via runBridge

  // 'rejects status when the evaluated target is closed|rotated before identity validation'
  // → stays in mm-harness: requires cdp-bridge.cjs via runBridge

  it('retains target identity and resumes a command on the next session generation', async () => {
    const requestDiscovery = mock.fn();
    const { broker, client, sendCommand, sessions } = await setup({ requestDiscovery });

    sessions.delete('device-1');
    broker.onSessionClose('device-1');
    const resolvedTargets = client.control('resolve-targets', { nameIncludes: 'mmdev-1' });
    await waitFor(() => {
      const called = requestDiscovery.mock.calls.some((c) => c.arguments[0] === 'device-1');
      assert.ok(called, 'requestDiscovery should have been called with device-1');
    });

    const replacementSession: SessionInfo = {
      deviceId: 'device-2',
      name: 'mmdev-1',
      opened: true,
      brokerReady: true,
    };
    sessions.set('device-2', replacementSession);
    broker.onSessionOpen('device-2');
    assertMatchesObject(await resolvedTargets, [
      { deviceId: 'device-2', generation: 1, name: 'mmdev-1', ready: true },
    ]);

    requestDiscovery.mock.resetCalls();
    const command = client.send('Runtime.evaluate', { expression: '1' }, 2_000);
    await waitFor(() => {
      const called = requestDiscovery.mock.calls.some((c) => c.arguments[0] === 'device-1');
      assert.ok(called, 'requestDiscovery should have been called with device-1 again');
    });
    assert.equal(sendCommand.mock.calls.length, 0, 'sendCommand should not have been called yet');

    sessions.delete('device-2');
    broker.onSessionClose('device-2');
    const nextSession: SessionInfo = {
      deviceId: 'device-1',
      name: 'mmdev-1',
      opened: true,
      brokerReady: true,
    };
    sessions.set('device-1', nextSession);
    broker.onSessionOpen('device-1');

    assert.deepEqual(await command, {});
    const sendCall = sendCommand.mock.calls[0];
    assert.ok(sendCall !== undefined);
    assert.equal(sendCall.arguments[0], nextSession);
    assert.equal(sendCall.arguments[1], 'Runtime.evaluate');
    assert.deepEqual(sendCall.arguments[2], { expression: '1' });
    assert.equal(typeof sendCall.arguments[3], 'number');

    assertMatchesObject(await client.control('resolve-targets', { nameIncludes: 'mmdev-1' }), [
      { deviceId: 'device-1', generation: 2, name: 'mmdev-1', ready: true },
    ]);
  });

  it('replays only the latest HUD update when the target returns', async () => {
    const requestDiscovery = mock.fn();
    const hudApplied = mock.fn(async (_session: unknown, method: string) =>
      method === 'Runtime.evaluate'
        ? { result: { objectId: 'global-1' } }
        : { result: { value: true } },
    );
    const { broker, client, sendCommand, sessions } = await setup({
      requestDiscovery,
      sendCommand: hudApplied,
    });
    sessions.delete('device-1');
    broker.onSessionClose('device-1');

    assertMatchesObject(
      await client.control('hud-update', { step: { intent: 'first', id: 'run 1/2' } }),
      { status: 'queued' },
    );
    assertMatchesObject(
      await client.control('hud-update', { step: { intent: 'second', id: 'run 2/2' } }),
      { status: 'queued' },
    );
    assert.equal(sendCommand.mock.calls.length, 0, 'sendCommand should not have been called yet');

    sessions.set('device-1', {
      deviceId: 'device-1',
      name: 'mmdev-1',
      opened: true,
      brokerReady: true,
    });
    broker.onSessionOpen('device-1');

    await waitFor(() => {
      assert.ok(
        sendCommand.mock.calls.length >= 2,
        'sendCommand should have been called at least twice',
      );
    });
    const hudCall = sendCommand.mock.calls.find((c) => c.arguments[1] === 'Runtime.callFunctionOn');
    assert.ok(hudCall !== undefined, 'expected a Runtime.callFunctionOn call');
    const args = hudCall.arguments[2] as { arguments?: Array<{ value: unknown }> };
    assert.deepEqual(args.arguments, [{ value: { intent: 'second', id: 'run 2/2' } }]);
  });

  it('waits for the HUD bridge before marking an update applied', async () => {
    const resolveValues = [
      { result: { objectId: 'global-1' } },
      { result: { value: false } },
      { result: { objectId: 'global-1' } },
      { result: { value: true } },
    ];
    const sendCommand = mock.fn(async () => resolveValues.shift());
    const { broker: _broker, client } = await setup({ sendCommand });

    assertMatchesObject(
      await client.control('hud-update', { step: { intent: 'ready', id: 'run 1/1' } }),
      { status: 'queued' },
    );
    await waitFor(() => {
      assert.equal(sendCommand.mock.calls.length, 4, 'expected 4 sendCommand calls');
    });
  });

  it('expires a session waiter before the client RPC deadline', async () => {
    const requestDiscovery = mock.fn();
    const { broker, client, sessions } = await setup({ requestDiscovery });

    sessions.delete('device-1');
    broker.onSessionClose('device-1');

    const startedAt = Date.now();
    await assert.rejects(
      client.send('Runtime.evaluate', { expression: '1' }, 2_000),
      /CDP broker target unavailable: device-1/,
    );
    assert.ok(Date.now() - startedAt < 2_000, 'should have failed before the 2s deadline');
    assert.ok(
      requestDiscovery.mock.calls.some((c) => c.arguments[0] === 'device-1'),
      'requestDiscovery should have been called with device-1',
    );
  });

  it('passes only the remaining RPC budget after session recovery', async () => {
    const requestDiscovery = mock.fn();
    const { broker, client, sendCommand, sessions } = await setup({ requestDiscovery });
    sessions.delete('device-1');
    broker.onSessionClose('device-1');

    const command = client.send('Runtime.evaluate', { expression: '1' }, 2_000);
    await waitFor(() => {
      assert.ok(
        requestDiscovery.mock.calls.some((c) => c.arguments[0] === 'device-1'),
        'requestDiscovery should have been called',
      );
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    sessions.set('device-1', {
      deviceId: 'device-1',
      name: 'mmdev-1',
      opened: true,
      brokerReady: true,
    });
    broker.onSessionOpen('device-1');
    assert.deepEqual(await command, {});

    const remainingMs = sendCommand.mock.calls[0]!.arguments[3] as number;
    assert.ok(remainingMs > 0, 'remaining budget should be > 0');
    assert.ok(remainingMs < 2_000, 'remaining budget should be < original 2000ms');
  });

  it('cancels a session waiter when its broker client closes', async () => {
    const requestDiscovery = mock.fn();
    const { broker, client, sendCommand, sessions } = await setup({ requestDiscovery });
    sessions.delete('device-1');
    broker.onSessionClose('device-1');

    const command = client.send('Runtime.evaluate', { expression: '1' }, 5_000);
    await waitFor(() => {
      assert.ok(
        requestDiscovery.mock.calls.some((c) => c.arguments[0] === 'device-1'),
        'requestDiscovery should have been called',
      );
    });
    client.close();
    await assert.rejects(command, /CDP broker closed/);

    sessions.set('device-1', {
      deviceId: 'device-1',
      name: 'mmdev-1',
      opened: true,
      brokerReady: true,
    });
    broker.onSessionOpen('device-1');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(sendCommand.mock.calls.length, 0, 'sendCommand should not have been called');
  });

  it('captures only matching requests and retained safe body fields', async () => {
    const { broker, client, sendCommand } = await setup();

    await client.control('capture-start', {
      id: 'perps',
      urlIncludes: ['api.hyperliquid.xyz/info'],
      methods: ['POST'],
      bodyJsonFields: ['type', 'req.coin'],
    });
    broker.onCdpEvent('device-1', 'Network.requestWillBeSent', {
      request: {
        url: 'https://api.hyperliquid.xyz/info?ignored=1',
        method: 'POST',
        postData: JSON.stringify({
          type: 'candleSnapshot',
          req: { coin: 'ETH' },
          user: 'must-not-be-retained',
        }),
      },
    });
    broker.onCdpEvent('device-1', 'Network.requestWillBeSent', {
      request: { url: 'https://example.com/info', method: 'POST' },
    });

    const summary = (await client.control('capture-end', { id: 'perps' })) as Record<
      string,
      unknown
    >;

    // Network.enable was called with a positive timeout <= 500ms.
    const enableCall = sendCommand.mock.calls.find((c) => c.arguments[1] === 'Network.enable');
    assert.ok(enableCall !== undefined, 'expected Network.enable call');
    assert.ok(enableCall.arguments[0] !== null && enableCall.arguments[0] !== undefined);
    assert.deepEqual(enableCall.arguments[2], {});
    assert.ok(
      typeof enableCall.arguments[3] === 'number' &&
        enableCall.arguments[3] > 0 &&
        enableCall.arguments[3] <= 500,
      `Network.enable timeout should be in (0,500], got ${String(enableCall.arguments[3])}`,
    );

    assertMatchesObject(summary, {
      status: 'complete',
      totalRequests: 1,
      requestsByType: { candleSnapshot: 1 },
      requests: [
        {
          host: 'api.hyperliquid.xyz',
          path: '/info',
          method: 'POST',
          body: { type: 'candleSnapshot', 'req.coin': 'ETH' },
        },
      ],
    });
    const summaryStr = JSON.stringify(summary);
    assert.ok(!summaryStr.includes('must-not-be-retained'), 'sensitive value must not be retained');
    assert.ok(!summaryStr.includes('ignored=1'), 'query param must not be retained');
  });

  it('reports a target rotation as partial', async () => {
    const { broker, client } = await setup();

    await client.control('capture-start', { id: 'restart' });
    broker.onSessionClose('device-1');
    broker.onSessionOpen('device-1');

    assertMatchesObject(await client.control('capture-end', { id: 'restart' }), {
      status: 'partial',
      reconnects: 1,
    });
  });

  it('reports an expired capture as partial without waiting for another event', async () => {
    const { client } = await setup();
    let now = 1_000;
    const dateSpy = mock.method(Date, 'now', () => now);

    await client.control('capture-start', { id: 'expired', maxDurationMs: 1_000 });
    now = 2_001;

    assertMatchesObject(await client.control('capture-end', { id: 'expired' }), {
      status: 'partial',
      totalRequests: 0,
    });
    dateSpy.mock.restore();
  });

  it('expires abandoned captures and returns their bounded partial summary', async () => {
    const { client } = await setup();

    await client.control('capture-start', { id: 'expired-timer', maxDurationMs: 10 });
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    assertMatchesObject(await client.control('capture-end', { id: 'expired-timer' }), {
      status: 'partial',
      totalRequests: 0,
    });
  });

  it('allows a stable capture id to restart after an abandoned window expires', async () => {
    const { client } = await setup();

    await client.control('capture-start', { id: 'reusable', maxDurationMs: 10 });
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    await client.control('capture-start', { id: 'reusable' });

    assertMatchesObject(await client.control('capture-end', { id: 'reusable' }), {
      status: 'complete',
    });
  });

  it('reports recovered Network enable coverage as partial, not unavailable', async () => {
    let shouldFail = true;
    const sendCommand = mock.fn(async () => {
      if (shouldFail) throw new Error('temporary enable failure');
      return {};
    });
    const { broker, client } = await setup({ sendCommand });

    await client.control('capture-start', { id: 'recovered' });
    shouldFail = false;
    broker.onSessionClose('device-1');
    broker.onSessionOpen('device-1');
    await waitFor(() => {
      assert.equal(sendCommand.mock.calls.length, 2, 'expected 2 sendCommand calls');
    });

    assertMatchesObject(await client.control('capture-end', { id: 'recovered' }), {
      status: 'partial',
      unavailableReasons: [],
      coverageGapReasons: ['temporary enable failure'],
    });
  });

  it('omits unbounded or sensitive allowlisted string values', async () => {
    const { broker, client } = await setup();

    await client.control('capture-start', {
      id: 'bounded-body',
      bodyJsonFields: ['type', 'opaque'],
    });
    broker.onCdpEvent('device-1', 'Network.requestWillBeSent', {
      request: {
        url: 'https://example.com/info/0x1234567890123456789012345678901234567890',
        method: 'POST',
        postData: JSON.stringify({ type: 'allMids', opaque: 'x'.repeat(300) }),
      },
    });

    const summary = (await client.control('capture-end', { id: 'bounded-body' })) as {
      requests: Array<{ path: string; body: Record<string, unknown> }>;
    };
    assert.equal(summary.requests[0]!.path, '/info/<redacted>');
    assert.equal(summary.requests[0]!.body['type'], 'allMids');
    assert.ok(
      !('opaque' in summary.requests[0]!.body),
      'opaque (oversized string) should have been omitted',
    );
  });

  it('marks matching requests partial when an allowlisted body cannot be inspected', async () => {
    const { broker, client } = await setup();

    await client.control('capture-start', { id: 'uninspectable-body', bodyJsonFields: ['type'] });
    broker.onCdpEvent('device-1', 'Network.requestWillBeSent', {
      request: {
        url: 'https://example.com/info',
        method: 'POST',
        postData: JSON.stringify({ type: 'x'.repeat(70_000) }),
      },
    });

    assertMatchesObject(await client.control('capture-end', { id: 'uninspectable-body' }), {
      status: 'partial',
      totalRequests: 1,
      uninspectableBodyRequests: 1,
      requestsByType: { unknown: 1 },
    });
  });

  it('rejects sensitive body fields', async () => {
    const { client } = await setup();

    await assert.rejects(
      client.control('capture-start', { id: 'unsafe', bodyJsonFields: ['user.address'] }),
      /sensitive/,
    );
  });

  it('refuses to replace a live broker socket owner', async () => {
    const { sendCommand, sessions, socketPath } = await setup();

    assert.throws(() => createCdpBroker({ socketPath, sessions, sendCommand }), /socket is owned/);
  });

  it('allows only one simultaneous process to claim a broker socket', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cdp-broker-race-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const socketPath = path.join(directory, 'broker.sock');
    const brokerPath = fileURLToPath(new URL('../cdp-broker/cdp-broker.cjs', import.meta.url));
    const script = `
      const { createCdpBroker } = require(${JSON.stringify(brokerPath)});
      try {
        const broker = createCdpBroker({
          socketPath: ${JSON.stringify(socketPath)},
          sessions: new Map(),
          sendCommand: async () => ({}),
        });
        process.send('won');
        process.once('message', () => { broker.close(); process.exit(0); });
      } catch (error) {
        if (!error.message.includes('socket is owned')) throw error;
        process.send('lost', () => process.exit(0));
      }
    `;
    const run = () => {
      const child = spawn(process.execPath, ['-e', script], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      cleanups.push(() => {
        child.kill();
      });
      const outcome = new Promise<string>((resolve, reject) => {
        child.once('message', (msg: string) => resolve(msg));
        child.once('error', reject);
        child.once('exit', (code: number | null) => {
          if (code !== 0 && code !== null) reject(new Error(`child exited ${code}`));
        });
      });
      const exited = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code: number | null) =>
          code === 0 ? resolve() : reject(new Error(`child exited ${code}`)),
        );
      });
      return { child, outcome, exited };
    };

    const contenders = [run(), run()];
    const outcomes = await Promise.all(contenders.map(({ outcome }) => outcome));
    contenders.forEach(({ child }, index) => {
      if (outcomes[index] === 'won') child.send('release');
    });
    await Promise.all(contenders.map(({ exited }) => exited));
    assert.ok(
      outcomes.includes('won') && outcomes.includes('lost'),
      `expected one won and one lost, got: ${JSON.stringify(outcomes)}`,
    );
  });

  it('rejects a non-object RPC frame without crashing the broker', async () => {
    const { client, socketPath } = await setup();
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.once('error', reject);
      socket.once('data', () => {
        socket.destroy();
        resolve();
      });
      socket.once('connect', () => socket.write('null\n'));
    });

    await client.control('capture-start', { id: 'still-alive' });
    assertMatchesObject(await client.control('capture-end', { id: 'still-alive' }), {
      status: 'complete',
    });
  });

  it('marks brokered command activity for debugger-yield coordination', async () => {
    const onClientActivity = mock.fn();
    const { client } = await setup({ onClientActivity });

    await client.control('capture-start', { id: 'activity' });
    await client.control('capture-end', { id: 'activity' });

    assert.equal(onClientActivity.mock.calls.length, 2);
  });
});
