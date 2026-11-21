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
 *   GET  /read            → { sessionId, state, cursor, completedTurns, commands, lastCompleted }:
 *                           cursor is the journal's latest sequence; lastCompleted the commandId and
 *                           sequence of the last turn.completed
 *   POST /shutdown        → closes the session, stops the private native host, exits
 *
 * NATIVE_STREAM_RUNNER (default claude), NATIVE_STREAM_FIXTURE (a file in
 * scripts/runner-validation/fixtures, installed as that runner's binary) and NATIVE_STREAM_MODEL
 * swap in another synthetic peer. NATIVE_STREAM_FIXTURE=none runs the real runner from PATH instead
 * (NATIVE_STREAM_RUNNER=codex for native-conversation.recipe.json) and keeps CODEX_LB_API_KEY, which
 * synthetic runs drop. NATIVE_STREAM_TOKEN_FILE, a new path, receives the setup operator's access
 * token (mode 0600) for native-conversation-proof.mts; POST /token writes a fresh one, since access
 * tokens expire within a long proof. The clean stop deletes the file.
 * NATIVE_STREAM_SEED_RUNS=<n> creates n active runs (fix-bug, status monitoring, no slot; the run
 * engine is off) so Companion's Review queue has rows to scroll, as jank.recipe.json's review-scroll
 * window needs.
 * NATIVE_STREAM_SEED_TERMINALS=<n> registers one test node for Companion's Terminals list, which
 * shows only registered nodes' tmux panes: a private tmux server (its own socket directory under
 * /tmp) runs n idle `sleep` sessions, and a node agent with a scratch HOME, pool directory and
 * screen-control socket, a clean environment and a node credential from this stack's own store
 * connects as machine stream-fixture, which this stack's pool lists with one enabled slot. It sees
 * only that tmux server; shared nodes and existing sessions are never discovered. Teardown stops
 * the node, kills that tmux server and removes its directory. The ready line names the node pid,
 * tmux server pid and socket.
 * NATIVE_STREAM_SEED_DIR is copied into the session folder, which
 * then becomes a Git repository with one commit, so turns get checkpoints and diffs.
 *
 * Every exit path tears down what started: /shutdown, SIGINT, SIGTERM, SIGHUP (tmux kill-session) and
 * a startup failure. A clean stop removes the temp root, which holds credentials; a failure keeps it
 * and logs its path.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type {
  NativeSessionDeltaPayload,
  NativeSessionInfo,
  NativeSessionReadResult,
  PairingCreateResult,
  TmuxWorkerListResult,
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
  terminals?: FixtureTerminals;
}
/** The NATIVE_STREAM_SEED_TERMINALS node and tmux server, for teardown and its checks. */
interface FixtureTerminals {
  machine: string;
  panes: number;
  nodePid: number;
  tmuxDir: string;
  tmuxSocket: string;
  tmuxServerPid: number;
}

const runner = process.env.NATIVE_STREAM_RUNNER ?? 'claude';
const fixture = process.env.NATIVE_STREAM_FIXTURE ?? 'native-stream-latency-claude.cjs';
const binaries: Record<string, string> = { claude: 'claude', opencode: 'opencode', codex: 'codex' };
const realRunner = fixture === 'none';
/**
 * NATIVE_STREAM_WIRE_LOG, a new path: one JSON line per frame the gateway sends to a client, with
 * its send time (epoch ms, sub-ms), the socket, the event name and bytes; for a native.session.delta
 * event also its update kind and the sequences of its native events. With the host journal's append
 * times it shows whether the relay pairs deltas.
 */
const wireLog = process.env.NATIVE_STREAM_WIRE_LOG;
assert(!wireLog || !fs.existsSync(wireLog), 'NATIVE_STREAM_WIRE_LOG must be a new path');
const tokenFile = process.env.NATIVE_STREAM_TOKEN_FILE;
assert(!tokenFile || !fs.existsSync(tokenFile), 'NATIVE_STREAM_TOKEN_FILE must be a new path');
assert(binaries[runner], `NATIVE_STREAM_RUNNER: one of ${Object.keys(binaries).join(', ')}`);
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
  /** Renews the setup connection before its access token expires. */
  renewal?: ReturnType<typeof setInterval>;
  /** The NATIVE_STREAM_SEED_TERMINALS tmux directory, once created, and node, once spawned. */
  tmuxDir?: string;
  terminalNode?: ChildProcess;
}
const running: Running = {};
/** Writes a fresh setup-operator access token to NATIVE_STREAM_TOKEN_FILE; set at startup. */
let writeToken: (() => Promise<void>) | undefined;

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
/** How far GET /read has paged the session's journal, and the last turn.completed in it. */
interface JournalPosition {
  cursor: number;
  lastCompleted?: { commandId: string; cursor: number };
}
let journal: JournalPosition = { cursor: 0 };
/** Pages the journal from where the last call stopped to its end; returns the last page. */
async function readJournal() {
  for (;;) {
    const page = await connected().call<NativeSessionReadResult>('native.session.read', {
      ...target(),
      after: journal.cursor,
      limit: 500,
    });
    for (const event of page.events)
      if (event.type === 'turn.completed' && event.commandId)
        journal.lastCompleted = { commandId: event.commandId, cursor: event.sequence };
    journal.cursor = page.cursor;
    if (!page.hasMore) return page;
  }
}

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

const FIXTURE_MACHINE = 'stream-fixture';
/** The environment of the fixture's tmux commands: its own server, never the caller's. */
const fixtureTmuxEnv = (tmuxDir: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: tmuxDir };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
};
const fixtureTmux = (tmuxDir: string, ...args: string[]) =>
  execFileSync('tmux', args, { env: fixtureTmuxEnv(tmuxDir), encoding: 'utf8' }).trim();

/** NATIVE_STREAM_SEED_TERMINALS: n idle panes on a private tmux server, reported by one test node. */
async function startTerminals(count: number, nodeSecret: string): Promise<FixtureTerminals> {
  // Under /tmp: a Unix socket path must stay under 104 bytes, and the temp root is too deep.
  // Real path: tmux reports /private/tmp on macOS.
  const tmuxDir = fs.realpathSync(await mkdtemp('/tmp/nst-'));
  running.tmuxDir = tmuxDir;
  for (let index = 1; index <= count; index++)
    fixtureTmux(
      tmuxDir,
      'new-session',
      '-d',
      '-s',
      `scratch-${String(index).padStart(2, '0')}`,
      'sleep',
      '86400',
    );
  const tmuxServerPid = Number(fixtureTmux(tmuxDir, 'display-message', '-p', '#{pid}'));
  const tmuxSocket = fixtureTmux(tmuxDir, 'display-message', '-p', '#{socket_path}');
  assert(tmuxSocket.startsWith(tmuxDir), `The fixture tmux server is not private: ${tmuxSocket}`);
  // The gateway lists tmux workers only for machines with an enabled slot in a pool. This slot's
  // session matches none of the panes, so they all list as non-Farmslot; the host never resolves.
  const pool = {
    schema_version: 2,
    machine: FIXTURE_MACHINE,
    project: 'stream',
    platform: 'web',
    os: 'macos',
    host: `${FIXTURE_MACHINE}.invalid`,
    slots: [
      {
        id: `${FIXTURE_MACHINE}-1`,
        enabled: true,
        repo: path.join(root, 'cwd'),
        session: `${FIXTURE_MACHINE}-1`,
        resources: {},
      },
    ],
  };
  await writeFile(path.join(root, 'pool', `${FIXTURE_MACHINE}.json`), `${JSON.stringify(pool)}\n`);
  const home = path.join(root, 'node-home');
  await mkdir(home, { recursive: true });
  await mkdir(path.join(root, 'node-pool'), { recursive: true });
  // A clean environment: the stack's own FARMSLOT_* variables (its home, native state directory
  // and native owner) would make the node share the gateway's state.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    USER: process.env.USER,
    LANG: process.env.LANG,
    TMPDIR: process.env.TMPDIR,
    HOME: home,
    TMUX_TMPDIR: tmuxDir,
    GATEWAY_URL: gatewayUrl,
    MACHINE_NAME: FIXTURE_MACHINE,
    FARMSLOT_NODE_TOKEN: nodeSecret,
    FARMSLOT_POOL_DIR: path.join(root, 'node-pool'),
    SCREEN_CONTROL_SOCKET: path.join(tmuxDir, 'screen.sock'),
    TSX_TSCONFIG_PATH: path.join(repo, 'services/node/tsconfig.json'),
  };
  const log = fs.openSync(path.join(root, 'node.log'), 'a');
  const node = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(path.join(repo, 'node_modules/tsx/dist/loader.mjs')).href,
      path.join(repo, 'services/node/src/index.ts'),
    ],
    // Its working directory is under the root, so it reads no checkout's .env for a node token.
    { cwd: home, env, stdio: ['ignore', log, log] },
  );
  running.terminalNode = node;
  assert(node.pid, 'The fixture node did not start');
  // The node's panes reach the gateway's tmux worker list once it has registered.
  await until(
    async () =>
      (await connected().call<TmuxWorkerListResult>('tmux.worker.list', {})).workers.length >=
      count,
    'the fixture node panes',
    60_000,
  );
  return {
    machine: FIXTURE_MACHINE,
    panes: count,
    nodePid: node.pid,
    tmuxDir,
    tmuxSocket,
    tmuxServerPid,
  };
}

async function stopTerminalNode() {
  const node = running.terminalNode!;
  if (node.exitCode !== null || node.signalCode !== null) return;
  const exited = new Promise((resolve) => node.once('exit', resolve));
  node.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('The fixture node did not exit')), 15_000).unref(),
    ),
  ]);
}

async function stopTerminalTmux() {
  const tmuxDir = running.tmuxDir!;
  // A server that never started (a failed first new-session) leaves only the directory.
  if (fs.readdirSync(tmuxDir).some((name) => name.startsWith('tmux-')))
    fixtureTmux(tmuxDir, 'kill-server');
  fs.rmSync(tmuxDir, { recursive: true, force: true });
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
  clearInterval(running.renewal);
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
  if (running.terminalNode) await step(stopTerminalNode);
  if (running.tmuxDir) await step(stopTerminalTmux);
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
// tmux kill-session hangs up the pane: without this the stack dies before teardown and the detached
// native supervisor, its host and runner processes outlive it.
process.on('SIGHUP', () => void finish());

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
          runner,
          model: process.env.NATIVE_STREAM_MODEL ?? 'haiku',
          cwd: path.join(root, 'cwd'),
          executionNodeId: 'local',
          mode: 'default',
          approvalMode: 'ask',
        },
      );
      state.sessionId = session.id;
      journal = { cursor: 0 };
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
      const page = await readJournal();
      return {
        sessionId: state.sessionId,
        state: page.session.state,
        cursor: journal.cursor,
        completedTurns: completedTurns(page),
        commands: page.commands.length,
        lastCompleted: journal.lastCompleted ?? null,
      };
    },
    'POST /token': async () => {
      assert(writeToken, 'Start the stack with NATIVE_STREAM_TOKEN_FILE');
      await writeToken();
      return { written: true };
    },
    'POST /shutdown': async () => {
      // After this reply is written.
      setTimeout(() => void finish(), 10);
      return { stopping: true };
    },
  };
}

/** Wraps each new socket's send, after the gateway's own connection handling, to log its frames. */
function logOutboundFrames(wss: GatewaySocketServer, file: string) {
  let sockets = 0;
  wss.on('connection', (socket: { send: (data: unknown, ...rest: unknown[]) => void }) => {
    const id = ++sockets;
    const send = socket.send.bind(socket);
    socket.send = (data: unknown, ...rest: unknown[]) => {
      const text =
        typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '';
      try {
        fs.appendFileSync(
          file,
          `${JSON.stringify({
            at: performance.timeOrigin + performance.now(),
            socket: id,
            bytes: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(text),
            ...frameEvents(text),
          })}\n`,
        );
      } catch (cause) {
        // A wire log that stops recording would make the measurement wrong: end the stack.
        void finish(cause);
      }
      send(data, ...rest);
    };
  });
}

/** A frame's event name; for a native.session.delta event frame also the envelope's update kind
 * and the sequences of its direct page.events or snapshot.events. Other frames carry none. */
function frameEvents(text: string): { event?: string; kind?: string; sequences: number[] } {
  const frame = JSON.parse(text) as { type?: string; event?: string; payload?: unknown };
  if (frame.type !== 'event') return { sequences: [] };
  if (frame.event !== 'native.session.delta') return { event: frame.event, sequences: [] };
  const update = frame.payload as NativeSessionDeltaPayload;
  const events =
    'page' in update ? update.page.events : 'snapshot' in update ? update.snapshot.events : [];
  return {
    event: frame.event,
    kind: update.kind,
    sequences: events.map((event) => event.sequence),
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
  if (!realRunner) {
    const executable = path.join(root, 'bin', binaries[runner]!);
    await copyFile(path.join(repo, 'scripts/runner-validation/fixtures', fixture), executable);
    fs.chmodSync(executable, 0o700);
  }
  const seed = process.env.NATIVE_STREAM_SEED_DIR;
  if (seed) {
    const cwd = path.join(root, 'cwd');
    fs.cpSync(seed, cwd, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
    git('init', '--quiet');
    git('add', '.');
    git(
      '-c',
      'user.name=proof',
      '-c',
      'user.email=proof@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'seed',
    );
  }
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
  // A synthetic peer must never reach a real model; the real runner needs its key.
  if (!realRunner) delete process.env.CODEX_LB_API_KEY;

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
  if (wireLog) logOutboundFrames(running.wss, wireLog);
  initServerGlobals();
  const seedRuns = Number(process.env.NATIVE_STREAM_SEED_RUNS ?? '0');
  assert(Number.isSafeInteger(seedRuns) && seedRuns >= 0, 'NATIVE_STREAM_SEED_RUNS: 0 or more');
  if (seedRuns) {
    const { createRun, updateRun } = await import('../../../../services/gateway/src/runs/store.js');
    for (let index = 1; index <= seedRuns; index++) {
      const run = createRun({
        flowType: 'fix-bug',
        project: 'stream',
        ticketOrPr: `STREAM-${index}`,
        mode: 'interactive',
      });
      updateRun(run.id, { status: 'monitoring' });
    }
  }
  await listen(running.server, port);
  const grant = await auth.writer.exchangePersonCredential(credential.secret, {
    deviceName: 'Companion stream setup',
    deviceKind: 'cli',
  });
  running.connection = await new GatewayClient({
    url: gatewayUrl,
    credential: { token: grant.accessToken },
    timeout: 60_000,
  }).connect();
  // Access tokens expire within an hour, and a proof session can outlive one: renew the setup
  // connection every 20 minutes. A failed renewal stops the stack rather than leave it half-working.
  running.renewal = setInterval(() => {
    void (async () => {
      const fresh = await auth.writer.exchangePersonCredential(credential.secret, {
        deviceName: 'Companion stream setup',
        deviceKind: 'cli',
      });
      const previous = running.connection;
      running.connection = await new GatewayClient({
        url: gatewayUrl,
        credential: { token: fresh.accessToken },
        timeout: 60_000,
      }).connect();
      // New calls use the new connection; one already in flight on the old one gets the client's
      // full 60 s timeout before that connection closes.
      setTimeout(() => previous?.close(), 60_000).unref();
    })().catch((cause: unknown) => void finish(cause));
  }, 20 * 60_000);
  running.renewal.unref();
  if (tokenFile) {
    await writeFile(tokenFile, `${grant.accessToken}\n`, { mode: 0o600, flag: 'wx' });
    process.on('exit', () => fs.rmSync(tokenFile, { force: true }));
    writeToken = async () => {
      const fresh = await auth.writer.exchangePersonCredential(credential.secret, {
        deviceName: 'Companion stream setup',
        deviceKind: 'cli',
      });
      // Replaced in one rename, so a proof phase never reads a half-written token. Each request
      // writes its own temp file: overlapping requests never share one, and a failed write or
      // rename removes it, since it holds a credential.
      const next = `${tokenFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(next, `${fresh.accessToken}\n`, { mode: 0o600, flag: 'wx' });
        fs.renameSync(next, tokenFile);
      } catch (cause) {
        fs.rmSync(next, { force: true });
        throw cause;
      }
    };
  }

  const seedTerminals = Number(process.env.NATIVE_STREAM_SEED_TERMINALS ?? '0');
  assert(
    Number.isSafeInteger(seedTerminals) && seedTerminals >= 0,
    'NATIVE_STREAM_SEED_TERMINALS: 0 or more',
  );
  if (seedTerminals) {
    const node = auth.writer.createPrincipal(
      { type: 'node', displayName: 'Stream fixture node', machine: FIXTURE_MACHINE },
      [],
      'stream-fixture-node',
    );
    const nodeCredential = auth.writer.issueCredential(node.id, 'Stream fixture node');
    state.terminals = await startTerminals(seedTerminals, nodeCredential.secret);
  }

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
