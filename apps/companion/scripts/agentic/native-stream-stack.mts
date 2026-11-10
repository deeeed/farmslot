/**
 * Isolated gateway for Companion native-stream proofs. A synthetic Claude stream-json peer
 * (scripts/runner-validation/fixtures/native-stream-latency-claude.cjs) is the `claude` runner, so
 * every turn streams NATIVE_LATENCY_DELTAS timestamped deltas with no model. The gateway listens on
 * 127.0.0.1:GATEWAY_PORT under a temp root and FARMSLOT_HOME, never the operator gateway.
 *
 *   GATEWAY_PORT=8861 CONTROL_PORT=8863 node --import tsx scripts/agentic/native-stream-stack.mts
 *
 * Control (127.0.0.1:CONTROL_PORT), for setup only; the app is driven through its own UI:
 *   POST /pair            → { link } a one-time farmslot-development:// pair link
 *   POST /session         → { sessionId } a new native session (runner claude, synthetic)
 *   POST /seed?turns=N    → sends N prompts over RPC, each waited to completion (keep N small:
 *                           a client's HTTP timeout can end the request; the seeding goes on)
 *   GET  /read            → { sessionId, state, cursor, completedTurns, commands }
 *   POST /shutdown        → closes the session, stops the private native host, exits
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  NativeSessionInfo,
  NativeSessionReadResult,
  PairingCreateResult,
} from '@farmslot/protocol';

import {
  buildGatewayPairingLink,
  buildGatewayPairingQrPayload,
} from '../../../../packages/protocol/src/rpc/auth.js';

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
for (const directory of ['scripts', 'services/gateway', 'pool', 'projects', 'bin', 'claude', 'cwd'])
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
  NATIVE_LATENCY_INTERVAL_MS: process.env.NATIVE_LATENCY_INTERVAL_MS ?? '20',
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
await new NativeSessionClient(path.join(root, 'native')).warm();

// The WebSocket server takes upgrades; plain requests get the health probe prepare-profile.sh uses.
const server = createServer((request, response) => {
  response.writeHead(request.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
  response.end(request.url === '/health' ? '{"ok":true}\n' : '{}\n');
});
const wss = createWebSocketServer(server, auth);
initServerGlobals();
await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
const gatewayUrl = `ws://127.0.0.1:${port}/ws`;
const grant = auth.writer.exchangePersonCredential(credential.secret, {
  deviceName: 'Companion stream setup',
  deviceKind: 'cli',
});
const connection = await new GatewayClient({
  url: gatewayUrl,
  credential: { token: grant.accessToken },
  timeout: 60_000,
}).connect();

const state: StackState = { root, gatewayUrl, controlUrl: `http://127.0.0.1:${controlPort}` };
const target = () => {
  assert(state.sessionId, 'POST /session first');
  return { sessionId: state.sessionId, executionNodeId: 'local' };
};
// Receipts, not events: a turn streams hundreds of events and a read pages at most 500.
const read = () =>
  connection.call<NativeSessionReadResult>('native.session.read', { ...target(), limit: 1 });
const completedTurns = (page: NativeSessionReadResult) =>
  page.commands.filter((command) => command.state === 'completed').length;
const until = async (check: () => Promise<boolean>, label: string, timeout = 120_000) => {
  const end = Date.now() + timeout;
  while (!(await check())) {
    assert(Date.now() < end, `Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

async function shutdown() {
  try {
    if (state.sessionId) await connection.call('native.session.close', target());
  } finally {
    connection.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => control.close(() => resolve()));
    const lock = path.join(root, 'native/lock/owner.json');
    if (fs.existsSync(lock)) {
      const supervisor = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number };
      const argv = execFileSync('ps', ['-p', String(supervisor.pid), '-o', 'command='], {
        encoding: 'utf8',
      });
      assert(argv.includes(path.join(root, 'native')));
      process.kill(supervisor.pid, 'SIGTERM');
      await until(
        async () => !fs.existsSync(path.join(root, 'native/lock')),
        'private host cleanup',
        30_000,
      );
    }
  }
}

type Handler = (url: URL) => Promise<unknown>;
const routes: Record<string, Handler> = {
  'POST /pair': async () => {
    const pairing = await connection.call<PairingCreateResult>('pairing.create', {
      gatewayUrl,
      profileName: 'Native stream proof',
      ttlSeconds: 600,
      authority: { kind: 'existing-principal', principalId: person.id },
    });
    const payload = buildGatewayPairingQrPayload(pairing, [{ gatewayUrl }]);
    return { link: buildGatewayPairingLink(payload, 'farmslot-development') };
  },
  'POST /session': async () => {
    const { session } = await connection.call<{ session: NativeSessionInfo }>(
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
      await connection.call('native.session.send', {
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
    // After this reply is written; a failed shutdown exits non-zero with its error.
    setTimeout(() => {
      shutdown().then(
        () => process.exit(0),
        (cause: unknown) => {
          console.error(cause);
          process.exit(1);
        },
      );
    }, 10);
    return { stopping: true };
  },
};

const control = createServer((request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', state.controlUrl);
  const route = routes[`${request.method} ${url.pathname}`];
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(`${JSON.stringify(body)}\n`);
  };
  if (!route) return reply(404, { error: 'unknown route' });
  route(url).then(
    (body) => reply(200, body),
    (cause: unknown) =>
      reply(500, { error: cause instanceof Error ? cause.message : String(cause) }),
  );
});
await new Promise<void>((resolve) => control.listen(controlPort, '127.0.0.1', resolve));
console.log(JSON.stringify({ ready: true, pid: process.pid, ...state }));
