import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { type WebSocket, WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);

type EvaluateParams = { expression: string };
type SendCommand = (session: unknown, method: string, params: EvaluateParams) => Promise<unknown>;

interface BrokerSession {
  deviceId: string;
  name: string;
  opened: boolean;
  brokerReady: boolean;
}

interface BrokerModule {
  brokerSocketPath(runtimeDir: string, endpointIdentity: number): string;
  createCdpBroker(options: {
    socketPath: string;
    sessions: Map<string, BrokerSession>;
    sendCommand: SendCommand;
  }): { close(): void };
}

interface BridgeErrorsModule {
  BRIDGE_ERROR_CODES: Record<string, string>;
  EXIT_CODE_BY_ERROR_CODE: Record<string, number>;
  ERROR_CODE_BY_EXIT_CODE: Record<number, string>;
  classifyBridgeErrorMessage(message: string): string | null;
  classifyBridgeResultError(command: string, result: unknown): string | null;
  formatErrorMarker(code: string, message: string): string;
  parseErrorMarker(text: string): string | null;
}

interface BridgeCoreModule {
  runBridgeCli(config: Record<string, unknown>): Promise<void>;
}

interface BridgeRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

const CORE = fileURLToPath(new URL('../../bridge-runtime/bridge-core.cjs', import.meta.url));
const broker = require('@farmslot/recipe-runner/cdp-broker') as BrokerModule;
const bridgeErrors = require(
  fileURLToPath(new URL('../../bridge-runtime/lib/bridge-errors.cjs', import.meta.url)),
) as BridgeErrorsModule;

// A tiny host preset: one command per behaviour under test, a route table, a
// recovery hint per code it cares about, and one placed help line.
const HOST_SCRIPT = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { runBridgeCli } = require(${JSON.stringify(CORE)});
runBridgeCli({
  appLabel: 'Demo',
  usagePath: 'demo-bridge.cjs',
  commands: {
    async 'demo-echo'(client, args, context) {
      const evaluated = await client.send('Runtime.evaluate', { expression: 'demoValue()', returnByValue: true });
      return { args, deviceName: context.deviceName, platform: context.platform, value: evaluated?.result?.value };
    },
    async 'demo-lock'() {
      return {
        lock: fs.readFileSync(path.join(process.env.RECIPE_RUNTIME_DIR, 'cdp-bridge.lock'), 'utf8'),
        pid: String(process.pid),
      };
    },
    async 'demo-fail'() {
      throw new Error('demo failure');
    },
  },
  commandDocs: {
    'demo-echo': {
      help: '  demo-echo <args...>                  Echo args from the demo host',
      helpAfter: 'go-back',
      listAfter: 'eval',
    },
  },
  routes: { aliases: { Home: 'HomeView' }, nestedParents: { HomeView: 'HomeNav' } },
  teachingByErrorCode: {
    METRO_UNREACHABLE: 'Next: start the demo Metro.',
    NO_TARGET: 'Next: open the demo app.',
  },
});
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-core-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function runBridge(
  directory: string,
  port: number,
  args: string[],
  env: Record<string, string> = {},
): Promise<BridgeRun> {
  const script = path.join(directory, 'demo-bridge.cjs');
  await writeFile(script, HOST_SCRIPT);
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    APP_ROOT: directory,
    CDP_TIMEOUT: '1000',
    CDP_DISCOVERY_RETRIES: '1',
    RECIPE_RUNTIME_DIR: directory,
    WATCHER_PORT: String(port),
    ...env,
  };
  for (const pin of [
    'ANDROID_DEVICE',
    'ANDROID_TARGET_DEVICE_NAME',
    'IOS_SIMULATOR',
    'RECIPE_RN_EXPLICIT_PLATFORM',
    'CDP_BRIDGE_LOCK_OWNER_PID',
  ]) {
    if (!(pin in env)) delete childEnv[pin];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: directory, env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** A live CDP broker over one ready device, answering Runtime.evaluate via `evaluate`. */
async function startBroker(evaluate: (expression: string) => unknown) {
  const directory = await tempDir();
  const port = await freePort();
  const expressions: string[] = [];
  const sessions = new Map<string, BrokerSession>([
    ['device-1', { deviceId: 'device-1', name: 'demo-1', opened: true, brokerReady: true }],
  ]);
  const instance = broker.createCdpBroker({
    socketPath: broker.brokerSocketPath(directory, port),
    sessions,
    sendCommand: async (_session, method, params) => {
      assert.equal(method, 'Runtime.evaluate');
      expressions.push(params.expression);
      return { result: { value: evaluate(params.expression) } };
    },
  });
  cleanups.push(() => instance.close());
  return { directory, port, expressions };
}

/** A stub Metro inspector: /json/list with one Hermes page and a WebSocket CDP endpoint. */
async function startInspector() {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  server.on('request', (request, response) => {
    if (request.url !== '/json/list') {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify([
        {
          id: 'dev1-2',
          title: 'Demo (demo-1)',
          deviceName: 'demo-1',
          description: 'React Native Bridgeless [Hermes]',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector/debug?device=dev1&page=2`,
        },
      ]),
    );
  });
  wss.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(String(raw)) as { id: number; params?: EvaluateParams };
      const expression = message.params?.expression || '';
      const value = expression.includes('typeof globalThis.__AGENTIC__')
        ? 'object'
        : expression.includes('__AGENTIC__?.platform')
          ? 'android'
          : null;
      socket.send(JSON.stringify({ id: message.id, result: { result: { value } } }));
    });
  });
  cleanups.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return port;
}

describe('bridge core', () => {
  it('runs a host command through the CDP broker', async () => {
    const { directory, port, expressions } = await startBroker((expression) =>
      expression.includes('__AGENTIC__?.platform') ? 'android' : 42,
    );

    const result = await runBridge(directory, port, ['demo-echo', 'a', 'b']);

    assert.equal(result.stderr, '');
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ['a', 'b'],
      deviceName: 'demo-1',
      platform: 'android',
      value: 42,
    });
    assert.ok(expressions.includes('demoValue()'));
    // The broker owns the debugger slot, so the bridge takes no lock.
    assert.equal(existsSync(path.join(directory, 'cdp-bridge.lock')), false);
  });

  it('rejects a host command that collides with a built-in, and unknown doc anchors', () => {
    const { runBridgeCli } = require(CORE) as BridgeCoreModule;
    assert.throws(
      () => runBridgeCli({ commands: { eval: async () => null } }),
      /host command eval collides with a built-in command/,
    );
    assert.throws(
      () => runBridgeCli({ commands: { extra: async () => null }, commandDocs: { other: {} } }),
      /commandDocs names unknown host command other/,
    );
    assert.throws(
      () =>
        runBridgeCli({
          commands: { extra: async () => null },
          commandDocs: { extra: { help: '  extra', helpAfter: 'missing' } },
        }),
      /commandDocs\.extra\.helpAfter names unknown command missing/,
    );
  });

  it('navigates with the host route table', async () => {
    const { directory, port, expressions } = await startBroker((expression) => {
      if (expression.includes('__AGENTIC__?.platform')) return 'android';
      if (expression.includes('getRoute()')) return { name: 'HomeView' };
      return null;
    });

    const nested = await runBridge(directory, port, ['navigate', 'Home', '{"tab":"main"}']);
    assert.equal(nested.code, 0, nested.stderr);
    assert.deepEqual(JSON.parse(nested.stdout), {
      navigated: 'HomeView',
      params: { tab: 'main' },
      previousRoute: { name: 'HomeView' },
      currentRoute: { name: 'HomeView' },
      deviceName: 'demo-1',
      platform: 'android',
    });
    assert.ok(
      expressions.some((expression) =>
        expression.includes(
          'globalThis.__AGENTIC__?.navigate("HomeNav", {"screen":"HomeView","params":{"tab":"main"}})',
        ),
      ),
      expressions.join('\n'),
    );

    const root = await runBridge(directory, port, ['navigate', 'Settings']);
    assert.equal(root.code, 0, root.stderr);
    assert.ok(
      expressions.some((expression) =>
        expression.includes('globalThis.__AGENTIC__?.navigate("Settings", {})'),
      ),
    );
  });

  it('prints help with the app label, built-ins and placed host lines', async () => {
    const directory = await tempDir();

    const help = await runBridge(directory, 1, ['--help']);

    assert.equal(help.code, 0);
    assert.equal(help.stderr, '');
    const lines = help.stdout.split('\n');
    assert.equal(lines[0], 'CDP Bridge — interact with the running Demo app via Hermes CDP');
    assert.ok(lines.includes('  node demo-bridge.cjs <command> [args...]'));
    const goBack = lines.findIndex((line) => line.startsWith('  go-back '));
    assert.equal(
      lines[goBack + 1],
      '  demo-echo <args...>                  Echo args from the demo host',
    );
    assert.ok(lines.some((line) => line.startsWith('  press-text <text>')));
    assert.ok(lines.some((line) => line.startsWith('  network-capture-end <json>')));

    const unknown = await runBridge(directory, 1, ['bogus']);
    assert.equal(unknown.code, 1);
    assert.equal(unknown.stdout, '');
    const available = unknown.stderr.split('\n')[1];
    assert.match(available, /^Available: target-identity-selected, navigate, /);
    assert.match(available, /, eval, demo-echo, eval-async, /);
    assert.match(available, /, network-capture-end, demo-lock, demo-fail$/);
  });

  it('appends the host teaching hint to a coded failure and exits with its code', async () => {
    const directory = await tempDir();
    const deadPort = await freePort();

    const unreachable = await runBridge(directory, deadPort, ['get-route']);

    assert.equal(
      unreachable.code,
      bridgeErrors.EXIT_CODE_BY_ERROR_CODE[bridgeErrors.BRIDGE_ERROR_CODES.METRO_UNREACHABLE],
    );
    assert.equal(unreachable.stdout, '');
    const [marker, ...rest] = unreachable.stderr.trimEnd().split('\n');
    assert.match(marker, /^ERROR\[METRO_UNREACHABLE\]: Cannot reach Metro at /);
    assert.equal(rest.at(-1), 'Next: start the demo Metro.');

    // A coded failure raised at the throw site (broker target selection).
    const { directory: brokerDir, port } = await startBroker(() => null);
    const noTarget = await runBridge(brokerDir, port, ['get-route'], {
      RECIPE_RN_EXPLICIT_PLATFORM: 'android',
      ANDROID_TARGET_DEVICE_NAME: 'other-device',
    });
    assert.equal(
      noTarget.code,
      bridgeErrors.EXIT_CODE_BY_ERROR_CODE[bridgeErrors.BRIDGE_ERROR_CODES.NO_TARGET],
    );
    assert.match(noTarget.stderr, /^ERROR\[NO_TARGET\]: .+\nNext: open the demo app\.\n$/);

    // An unclassified failure keeps the plain marker, exit 1 and no hint.
    const failed = await runBridge(brokerDir, port, ['demo-fail']);
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, 'ERROR: demo failure\n');
  });

  it('classifies bridge failures into typed codes that round-trip', () => {
    const cases: Array<[string, string]> = [
      [
        'Cannot reach Metro at http://localhost:8081/json/list. Is Metro running?',
        'METRO_UNREACHABLE',
      ],
      ['Timeout fetching http://localhost:8081/json/list after 30000ms', 'METRO_UNREACHABLE'],
      ['No debug targets found at http://localhost:8081/json/list', 'NO_TARGET'],
      ['Pinned Android device did not match any Metro target.', 'NO_TARGET'],
      ['Pinned android device abc123 has no responding bridge target.', 'NO_TARGET'],
      ['WebSocket closed', 'WS_CLOSED'],
      ['WebSocket error: ECONNRESET', 'WS_CLOSED'],
      ['CDP connection timeout after 5000ms', 'CDP_TIMEOUT'],
      ['CDP message timeout after 10000ms for Runtime.evaluate', 'CDP_TIMEOUT'],
      ['CDP broker connection timeout', 'CDP_TIMEOUT'],
      ['CDP broker request timeout', 'CDP_TIMEOUT'],
      ['Async evaluation timed out after 30000ms', 'CDP_TIMEOUT'],
    ];
    for (const [message, expected] of cases) {
      assert.equal(bridgeErrors.classifyBridgeErrorMessage(message), expected, message);
    }
    assert.equal(bridgeErrors.classifyBridgeErrorMessage('SyntaxError: Unexpected token'), null);

    for (const error of [
      'No scrollable near testID=demo-scroll-view',
      'No scrollable found near testID="demo-scroll-view"',
    ]) {
      assert.equal(
        bridgeErrors.classifyBridgeResultError('scroll-view', { ok: false, error }),
        'SCROLLABLE_NOT_FOUND',
      );
    }
    assert.equal(
      bridgeErrors.classifyBridgeResultError('press-test-id', {
        ok: false,
        error: 'No scrollable near testID=demo-scroll-view',
      }),
      null,
    );
    assert.equal(
      bridgeErrors.classifyBridgeResultError('scroll-view', {
        ok: false,
        error: 'Scroll failed unexpectedly',
      }),
      null,
    );

    for (const code of Object.values(bridgeErrors.BRIDGE_ERROR_CODES)) {
      const exit = bridgeErrors.EXIT_CODE_BY_ERROR_CODE[code];
      assert.ok(exit, code);
      assert.equal(bridgeErrors.ERROR_CODE_BY_EXIT_CODE[exit], code);
    }
    assert.equal(
      bridgeErrors.parseErrorMarker(bridgeErrors.formatErrorMarker('WS_CLOSED', 'x')),
      'WS_CLOSED',
    );
  });

  describe('debugger-slot lock', () => {
    it('holds a child-owned lock while a direct command runs and releases it on exit', async () => {
      const directory = await tempDir();
      const port = await startInspector();

      const result = await runBridge(directory, port, ['demo-lock']);

      assert.equal(result.code, 0, result.stderr);
      const { lock, pid } = JSON.parse(result.stdout) as { lock: string; pid: string };
      assert.equal(lock, pid);
      assert.equal(existsSync(path.join(directory, 'cdp-bridge.lock')), false);
    });

    it('keeps a caller-owned lock when the child fails discovery', async () => {
      const directory = await tempDir();
      const deadPort = await freePort();
      const owner = String(process.pid);

      const result = await runBridge(directory, deadPort, ['get-route'], {
        CDP_BRIDGE_LOCK_OWNER_PID: owner,
      });

      assert.notEqual(result.code, 0);
      assert.equal(await readFile(path.join(directory, 'cdp-bridge.lock'), 'utf8'), owner);
    });

    it('leaves another writer’s lock alone on a no-lock invocation', async () => {
      const directory = await tempDir();
      const lockFile = path.join(directory, 'cdp-bridge.lock');
      await writeFile(lockFile, '424242');

      const help = await runBridge(directory, 1, ['--help']);
      const unknown = await runBridge(directory, 1, ['bogus']);

      assert.equal(help.code, 0);
      assert.equal(unknown.code, 1);
      assert.equal(await readFile(lockFile, 'utf8'), '424242');
    });
  });
});
