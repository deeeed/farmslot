/**
 * Isolated gateway for Companion native-stream proofs. A synthetic Claude stream-json peer
 * (scripts/runner-validation/fixtures/native-stream-latency-claude.cjs) is the `claude` runner, so
 * every turn streams NATIVE_LATENCY_DELTAS (200) timestamped deltas, one every
 * NATIVE_LATENCY_INTERVAL_MS (50), with no model. The gateway listens on
 * 127.0.0.1:GATEWAY_PORT under a temp root and FARMSLOT_HOME, never the operator gateway.
 *
 *   # from the repository root
 *   TSX_TSCONFIG_PATH=services/gateway/tsconfig.json GATEWAY_PORT=8861 CONTROL_PORT=8863 \
 *     node --import tsx apps/companion/scripts/agentic/native-stream-stack.mts
 *
 * Control (127.0.0.1:CONTROL_PORT), for setup only; the app is driven through its own UI:
 *   POST /pair            → { link } a one-time farmslot-development:// pair link
 *   POST /session         → { sessionId } a new native session (runner claude, synthetic)
 *   POST /seed?turns=N    → sends N prompts over RPC, each waited to completion (keep N small:
 *                           a client's HTTP timeout can end the request; the seeding goes on)
 *   GET  /read            → { sessionId, state, cursor, completedTurns, commands }
 *   POST /shutdown        → closes the session, stops the private native host, exits
 *
 * Every exit path tears down what started: /shutdown, SIGINT and SIGTERM, and a startup failure. A
 * clean stop removes the temp root, which holds credentials; a failure keeps it and logs its path.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  NativeSessionInfo,
  NativeSessionReadResult,
  PairingCreateResult,
} from '@farmslot/protocol';

import type { GatewayClient } from '../../../../packages/cli/src/gateway-client.js';
import {
  buildGatewayPairingLink,
  buildGatewayPairingQrPayload,
} from '../../../../packages/protocol/src/rpc/auth.js';
import type { createWebSocketServer } from '../../../../services/gateway/src/server.js';

interface StackState {
  root: string;
  gatewayUrl: string;
  controlUrl: string;
  sessionId?: string;
}

const port = Number(process.env.GATEWAY_PORT);
const controlPort = Number(process.env.CONTROL_PORT);
assert(Number.isSafeInteger(port) && port > 0, 'Set GATEWAY_PORT');
assert(Number.isSafeInteger(controlPort) && controlPort > 0, 'Set CONTROL_PORT');
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'companion-native-stream-'));
const gatewayUrl = `ws://127.0.0.1:${port}/ws`;
const state: StackState = { root, gatewayUrl, controlUrl: `http://127.0.0.1:${controlPort}` };

type GatewayConnection = Awaited<ReturnType<GatewayClient['connect']>>;
type GatewaySocketServer = ReturnType<typeof createWebSocketServer>;
/** What startup has brought up so far, for teardown on any exit path. */
interface Running {
  hostWarmed?: boolean;
  server?: Server;
  wss?: GatewaySocketServer;
  connection?: GatewayConnection;
  control?: Server;
}
const running: Running = {};

const listen = (server: Server, at: number) =>
  new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(at, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
const close = (server: Server | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (!server?.listening) return resolve();
    server.close((cause) => (cause ? reject(cause) : resolve()));
  });
const until = async (check: () => Promise<boolean>, label: string, timeout = 120_000) => {
  const end = Date.now() + timeout;
  while (!(await check())) {
    assert(Date.now() < end, `Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};
const target = () => {
  assert(state.sessionId, 'POST /session first');
  return { sessionId: state.sessionId, executionNodeId: 'local' };
};
const connected = () => {
  assert(running.connection, 'The gateway is not connected');
  return running.connection;
};
// Receipts, not events: a turn streams hundreds of events and a read pages at most 500.
const read = () =>
  connected().call<NativeSessionReadResult>('native.session.read', { ...target(), limit: 1 });
const completedTurns = (page: NativeSessionReadResult) =>
  page.commands.filter((command) => command.state === 'completed').length;

/** The private native host the warm-up started, found by its lock under this root. */
async function stopHost() {
  const lock = path.join(root, 'native/lock/owner.json');
  if (!fs.existsSync(lock)) return;
  const supervisor = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number };
  const argv = execFileSync('ps', ['-p', String(supervisor.pid), '-o', 'command='], {
    encoding: 'utf8',
  });
  assert(argv.includes(path.join(root, 'native')), 'The lock names another process');
  process.kill(supervisor.pid, 'SIGTERM');
  await until(
    async () => !fs.existsSync(path.join(root, 'native/lock')),
    'private host cleanup',
    30_000,
  );
}

/** Stops everything that started, each step even if an earlier one failed; reports every
 * failure. */
async function teardown() {
  const failures: unknown[] = [];
  const step = async (run: () => unknown) => {
    try {
      await run();
    } catch (cause) {
      failures.push(cause);
    }
  };
  if (state.sessionId && running.connection)
    await step(() => connected().call('native.session.close', target()));
  await step(() => running.connection?.close());
  await step(async () => {
    const wss = running.wss;
    if (!wss) return;
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      wss.close((cause) => (cause ? reject(cause) : resolve())),
    );
  });
  await step(() => close(running.server));
  await step(() => close(running.control));
  if (running.hostWarmed) await step(stopHost);
  if (failures.length) throw new AggregateError(failures, 'Teardown failed');
}

let stopping: Promise<void> | undefined;
/** Startup in flight. A stop waits for it to settle, so a signal mid-startup (before the detached
 * native supervisor has published its lock, say) cannot race it; its failure reaches `finish`. */
let startup: Promise<void> | undefined;
/** The one exit path. `cause` is the failure that ended the stack, if any. */
function finish(cause?: unknown) {
  stopping ??= Promise.allSettled([startup])
    .then(([settled]) => {
      // A startup that failed after a signal began the stop is still reported, never dropped.
      if (cause === undefined && settled?.status === 'rejected') cause = settled.reason;
      return teardown();
    })
    .then(
      () => {
        if (cause !== undefined) throw cause;
        // Clean: the root holds the gateway credentials and the private host's state.
        fs.rmSync(root, { recursive: true, force: true });
        console.log(`[native-stream-stack] stopped; removed ${root}`);
        process.exit(0);
      },
      (failure: unknown) => {
        throw cause === undefined ? failure : new AggregateError([cause, failure], 'Stack failed');
      },
    )
    .catch((failure: unknown) => {
      console.error(failure);
      console.error(`[native-stream-stack] failed; kept ${root} for inspection`);
      process.exit(1);
    });
  return stopping;
}
// `on`, not `once`: a dependency's signal-exit hook re-raises the signal, killing the process
// before teardown, once it is the last listener left. `finish` runs its teardown only once.
process.on('SIGINT', () => void finish());
process.on('SIGTERM', () => void finish());

type Handler = (url: URL) => Promise<unknown>;
function controlRoutes(personId: string): Record<string, Handler> {
  return {
    'POST /pair': async () => {
      const pairing = await connected().call<PairingCreateResult>('pairing.create', {
        gatewayUrl,
        profileName: 'Native stream proof',
        ttlSeconds: 600,
        authority: { kind: 'existing-principal', principalId: personId },
      });
      const payload = buildGatewayPairingQrPayload(pairing, [{ gatewayUrl }]);
      return { link: buildGatewayPairingLink(payload, 'farmslot-development') };
    },
    'POST /session': async () => {
      const { session } = await connected().call<{ session: NativeSessionInfo }>(
        'native.session.create',
        {
          runner: 'claude',
          model: 'haiku',
          cwd: path.join(root, 'cwd'),
          executionNodeId: 'local',
          mode: 'default',
          approvalMode: 'ask',
        },
      );
      state.sessionId = session.id;
      return { sessionId: session.id };
    },
    'POST /seed': async (url) => {
      const turns = Number(url.searchParams.get('turns') ?? '1');
      assert(Number.isSafeInteger(turns) && turns > 0 && turns <= 200);
      for (let index = 0; index < turns; index++) {
        const before = completedTurns(await read());
        await connected().call('native.session.send', {
          ...target(),
          commandId: `seed-${randomUUID()}`,
          text: `seed turn ${index}`,
        });
        await until(async () => completedTurns(await read()) > before, `seed turn ${index}`);
      }
      return { completedTurns: completedTurns(await read()) };
    },
    'GET /read': async () => {
      const page = await read();
      return {
        sessionId: state.sessionId,
        state: page.session.state,
        cursor: page.cursor,
        completedTurns: completedTurns(page),
        commands: page.commands.length,
      };
    },
    'POST /shutdown': async () => {
      // After this reply is written.
      setTimeout(() => void finish(), 10);
      return { stopping: true };
    },
  };
}

async function start() {
  for (const directory of [
    'scripts',
    'services/gateway',
    'pool',
    'projects',
    'bin',
    'claude',
    'cwd',
  ])
    await mkdir(path.join(root, directory), { recursive: true });
  await mkdir(path.join(root, 'packages/agent-runtime'), { recursive: true });
  fs.symlinkSync(
    path.join(repo, 'packages/agent-runtime/scripts'),
    path.join(root, 'packages/agent-runtime/scripts'),
    'dir',
  );
  await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated Companion native stream proof\n');
  await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
  await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
  await writeFile(
    path.join(root, 'pool/local.json'),
    JSON.stringify({ machine: 'local', project: 'stream', host: 'localhost', slots: [] }),
  );
  const executable = path.join(root, 'bin/claude');
  await copyFile(
    path.join(repo, 'scripts/runner-validation/fixtures/native-stream-latency-claude.cjs'),
    executable,
  );
  fs.chmodSync(executable, 0o700);
  Object.assign(process.env, {
    PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    NATIVE_LATENCY_DELTAS: process.env.NATIVE_LATENCY_DELTAS ?? '200',
    NATIVE_LATENCY_INTERVAL_MS: process.env.NATIVE_LATENCY_INTERVAL_MS ?? '50',
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    SCREEN_CONTROL_SOCKET: path.join(root, 'screen.sock'),
  });
  delete process.env.CODEX_LB_API_KEY;

  const { createGatewayAuthRuntime } =
    await import('../../../../services/gateway/src/security/auth.js');
  const { createWebSocketServer, initServerGlobals } =
    await import('../../../../services/gateway/src/server.js');
  const { GatewayClient } = await import('../../../../packages/cli/src/gateway-client.js');
  const { NativeSessionClient } =
    await import('../../../../packages/agent-runtime/src/native/client.js');

  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME });
  const roles = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
  const owner = auth.writer.createPrincipal(
    { type: 'service', displayName: 'Companion stream host' },
    roles,
    'companion-stream-host',
  );
  const person = auth.writer.createPrincipal(
    { type: 'person', displayName: 'Companion stream operator' },
    roles,
    'companion-stream-operator',
  );
  const credential = auth.writer.issueCredential(person.id, 'Companion stream setup');
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
  // From here a detached host may run: teardown looks for its lock even if warm-up fails midway.
  running.hostWarmed = true;
  await new NativeSessionClient(path.join(root, 'native')).warm();

  // The WebSocket server takes upgrades; plain requests get the health probe that
  // prepare-profile.sh uses.
  running.server = createServer((request, response) => {
    response.writeHead(request.url === '/health' ? 200 : 404, {
      'content-type': 'application/json',
    });
    response.end(request.url === '/health' ? '{"ok":true}\n' : '{}\n');
  });
  running.wss = createWebSocketServer(running.server, auth);
  initServerGlobals();
  await listen(running.server, port);
  const grant = auth.writer.exchangePersonCredential(credential.secret, {
    deviceName: 'Companion stream setup',
    deviceKind: 'cli',
  });
  running.connection = await new GatewayClient({
    url: gatewayUrl,
    credential: { token: grant.accessToken },
    timeout: 60_000,
  }).connect();

  const routes = controlRoutes(person.id);
  running.control = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', state.controlUrl);
    const route = routes[`${request.method} ${url.pathname}`];
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(`${JSON.stringify(body)}\n`);
    };
    // Loopback alone does not stop a DNS-rebinding page from reaching this unauthenticated port,
    // which can mint a pairing for an admin principal; only the exact loopback host is served.
    if (request.headers.host !== `127.0.0.1:${controlPort}`) return reply(403, { error: 'host' });
    if (!route) return reply(404, { error: 'unknown route' });
    route(url).then(
      (body) => reply(200, body),
      (cause: unknown) =>
        reply(500, { error: cause instanceof Error ? cause.message : String(cause) }),
    );
  });
  await listen(running.control, controlPort);
  console.log(JSON.stringify({ ready: true, pid: process.pid, ...state }));
}

startup = start();
await startup.catch((cause: unknown) => finish(cause));
