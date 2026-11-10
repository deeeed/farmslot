// Live proof of terminal fan-out backpressure on a private authenticated gateway.
// Two viewers attach to one interactive terminal on a private tmux server. One stops reading its
// socket while the pane floods output. The gateway must close that viewer for a resync (1013)
// without dropping bytes from what it did send, keep the healthy viewer streaming, and let the
// slow viewer re-attach to the current screen. Only owned processes and the private tmux socket
// are touched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket } from 'ws';

const code = fileURLToPath(new URL('../../../', import.meta.url));
const home = await mkdtemp(path.join(os.tmpdir(), 'terminal-pressure-'));
const output = path.resolve(
  process.env.FARMSLOT_PROOF_OUTPUT_DIR ?? 'temp/terminal-backpressure-proof',
);
// A short private tmux directory: the socket path must stay under the Unix socket length limit.
const tmuxDir = await mkdtemp('/tmp/fs-pressure-tmux-');
const tmuxSocket = path.join(tmuxDir, `tmux-${os.userInfo().uid}`, 'default');
delete process.env.TMUX;
delete process.env.TMUX_PANE;
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  TMUX_TMPDIR: tmuxDir,
  FARMSLOT_HOME: home,
  FARMSLOT_RUNS_DIR: path.join(home, 'runs'),
  FARMSLOT_POOL_DIR: path.join(home, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(home, 'projects'),
  FARMSLOT_TEST_STATUS_FILE: path.join(home, 'status.json'),
});
const slotId = 'pressure-slot';
const load = (file: string) => import(pathToFileURL(path.join(code, file)).href);
await mkdir(path.join(home, 'pool'));
await mkdir(path.join(home, 'runs'));
await mkdir(path.join(home, 'projects', 'pressure-proof'), { recursive: true });
await mkdir(path.join(home, 'checkout'));
await mkdir(output, { recursive: true });
await writeFile(
  path.join(home, 'projects', 'pressure-proof', 'project.json'),
  JSON.stringify({ name: 'pressure-proof', default_branch: 'main', hooks: {} }),
);
await writeFile(
  path.join(home, 'pool', 'local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project: 'pressure-proof',
    platform: 'cli',
    slots: [{ id: slotId, repo: path.join(home, 'checkout'), session: slotId }],
  }),
);
await writeFile(
  path.join(home, 'status.json'),
  JSON.stringify({ slots: [{ slot: slotId, lifecycle: 'ready' }] }),
);

const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
const person = auth.writer.createPrincipal({ type: 'person', displayName: 'Pressure proof' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
const secret = auth.writer.issueCredential(person.id, 'Disposable proof');
const grant = auth.writer.exchangePersonCredential(secret.secret, {
  deviceName: 'Proof',
  deviceKind: 'cli',
});
const { createWebSocketServer } = await load('services/gateway/src/server.ts');
const { JOINED_SCREEN_PREFIX, TERMINAL_BUFFER_LIMIT } = await load(
  'services/gateway/src/methods/terminal-frame.ts',
);

interface Viewer {
  ws: WebSocket;
  data: string[];
  bytes: number;
  closed: Promise<{ code: number; reason: string }>;
  call<T>(method: string, params: unknown): Promise<T>;
}
const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', tmuxSocket, ...args], { encoding: 'utf8' });
const until = async (condition: () => boolean, what: string | (() => string), ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${typeof what === 'function' ? what() : what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const server = createServer();
const wss: { clients: Set<WebSocket> } = createWebSocketServer(server, auth);
// The gateway has started closing a viewer's socket (sent its close frame).
const gatewayClosing = () =>
  [...wss.clients].some((socket) => socket.readyState === WebSocket.CLOSING);
const viewers: Viewer[] = [];
const evidence: Record<string, unknown> = { limitBytes: TERMINAL_BUFFER_LIMIT };
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}/ws`;

  async function viewer(): Promise<Viewer> {
    const ws = new WebSocket(url);
    const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
    let seq = 0;
    const self: Viewer = {
      ws,
      data: [],
      bytes: 0,
      closed: new Promise((resolve) =>
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
      ),
      call<T>(method: string, params: unknown) {
        const id = `pressure-${++seq}`;
        ws.send(JSON.stringify({ type: 'req', id, method, params }));
        return new Promise<T>((resolve, reject) =>
          pending.set(id, { resolve: (value) => resolve(value as T), reject }),
        );
      },
    };
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'res') {
        const entry = pending.get(frame.id);
        pending.delete(frame.id);
        if (frame.ok === false || frame.error)
          entry?.reject(new Error(frame.error?.message ?? 'request failed'));
        else entry?.resolve(frame.payload ?? frame.result);
      } else if (frame.type === 'event' && frame.event === 'terminal.data') {
        self.data.push(frame.payload.data);
        self.bytes += Buffer.byteLength(frame.payload.data);
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await self.call('auth.connect', {
      clientKind: 'ui',
      clientName: 'terminal-pressure-proof',
      token: grant.accessToken,
    });
    viewers.push(self);
    return self;
  }
  const subscribe = (v: Viewer) =>
    v.call('terminal.subscribe', {
      slotId,
      bareSession: true,
      interactive: true,
      cols: 200,
      rows: 50,
    });

  const healthy = await viewer();
  await subscribe(healthy);
  const slow = await viewer();
  await subscribe(slow);
  // The slow viewer stops reading: its unsent frames pile up in the gateway's socket buffer.
  slow.ws.pause();
  const slowBytesAtPause = slow.bytes;

  tmux('send-keys', '-t', slotId, '-l', `yes ${'0123456789abcdefghijklmnopqrstuvwxyz'.repeat(4)}`);
  tmux('send-keys', '-t', slotId, 'Enter');
  // Resume the slow viewer as soon as the gateway starts closing it, inside the close-handshake
  // timeout, so it reads the close frame. Without a close it resumes once the flood is done.
  await until(
    () => gatewayClosing() || healthy.bytes > 8 * TERMINAL_BUFFER_LIMIT,
    () => `a close or the flood (healthy ${healthy.bytes} B, slow ${slow.bytes} B)`,
    60_000,
  );
  evidence.gatewayClosedSlowViewer = gatewayClosing();
  slow.ws.resume();
  // Several times the limit plus kernel socket buffers.
  await until(
    () => healthy.bytes > 8 * TERMINAL_BUFFER_LIMIT,
    () => `the pane to flood (healthy ${healthy.bytes} B, slow ${slow.bytes} B)`,
    60_000,
  );
  tmux('send-keys', '-t', slotId, 'C-c');
  tmux('send-keys', '-t', slotId, '-l', 'clear; echo PRESSURE-DONE');
  tmux('send-keys', '-t', slotId, 'Enter');
  await until(() => healthy.data.join('').includes('PRESSURE-DONE'), 'the marker');

  let waited: ReturnType<typeof setTimeout> | undefined;
  const close = await Promise.race([
    slow.closed,
    new Promise<{ code: number; reason: string }>((resolve) => {
      waited = setTimeout(() => resolve({ code: 0, reason: 'still open after 10 s' }), 10_000);
    }),
  ]);
  clearTimeout(waited);
  // Output after the slow viewer drains: a viewer that silently lost frames would now receive
  // this after a gap, so its stream would stop being a prefix of the healthy one.
  tmux('send-keys', '-t', slotId, '-l', 'echo AFTER-RESUME');
  tmux('send-keys', '-t', slotId, 'Enter');
  await until(() => healthy.data.join('').includes('AFTER-RESUME'), 'the second marker');
  await new Promise((resolve) => setTimeout(resolve, 500));
  // Both viewers get each PTY chunk in the same pass, but the healthy one subscribed first: the
  // slow viewer's chunks must be one unbroken run of the healthy viewer's chunks.
  // A screen seed on joining is sent to the joining viewer only, so it is not part of the stream.
  const stream = (v: Viewer) => v.data.filter((chunk) => !chunk.startsWith(JOINED_SCREEN_PREFIX));
  const healthyStream = stream(healthy);
  const slowStream = stream(slow);
  const contiguous =
    slowStream.length > 0 &&
    healthyStream.some(
      (chunk, start) =>
        chunk === slowStream[0] && slowStream.every((next, k) => healthyStream[start + k] === next),
    );
  Object.assign(evidence, {
    slowClose: close,
    slowBytesAtPause,
    slowBytes: slow.bytes,
    healthyBytes: healthy.bytes,
    healthyOpen: healthy.ws.readyState === WebSocket.OPEN,
  });
  assert.ok(contiguous, 'the slow viewer got an unbroken run of the stream: no chunk was skipped');
  assert.deepEqual(close, { code: 1013, reason: 'Terminal resync required' });
  assert.ok(slow.bytes < healthy.bytes, 'the slow viewer was cut off before the flood ended');
  assert.equal(healthy.ws.readyState, WebSocket.OPEN, 'the healthy viewer keeps streaming');

  // Re-attach and redraw: the healthy viewer keeps the PTY alive, so the slow viewer's new
  // connection joins it and must be sent the current screen as terminal output, unasked.
  const again = await viewer();
  await subscribe(again);
  // Required from the gateway itself: tmux may or may not redraw a client that joins a session.
  await until(
    () =>
      again.data.some(
        (chunk) => chunk.startsWith(JOINED_SCREEN_PREFIX) && chunk.includes('PRESSURE-DONE'),
      ),
    'the re-attached viewer to be sent the current screen',
    10_000,
  );
  evidence.reattachedScreenHasMarker = true;
  evidence.result = 'pass';
} finally {
  await writeFile(
    path.join(output, 'terminal-backpressure.json'),
    JSON.stringify(evidence, null, 2),
  );
  for (const v of viewers) v.ws.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    tmux('kill-server');
  } catch (error) {
    // The private server may already be gone when the proof failed before attaching.
    if (!String((error as Error).message).includes('no server running')) throw error;
  }
  await rm(home, { recursive: true, force: true });
  await rm(tmuxDir, { recursive: true, force: true });
}
console.log(JSON.stringify(evidence));
process.exit(0);
