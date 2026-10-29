// Presentation proof over an isolated protocol fixture. It never starts a farm or a worker.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { WebSocket, WebSocketServer } from 'ws';

import {
  resourceCollectorReadMethods,
  resourceDependenciesForRead,
} from '../../../packages/protocol/src/client-cache/registry.ts';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const output = process.env.FARMSLOT_LAYOUT_EVIDENCE;
assert(output, 'Select an evidence directory');
const uiPort = Number(process.env.VITE_PORT);
const port = Number(process.env.GATEWAY_PORT);
assert(uiPort > 1024 && port > 1024 && uiPort !== port, 'Select two private ports');
assert(process.env.FARMSLOT_CDP_PORT, 'Select Agent Chrome CDP');
await mkdir(output, { recursive: true });
const execute = promisify(execFile);
const frames = [];
const epoch = 'layout-fixture-epoch';
let revision = 0;
let mode = 'empty';
const now = Date.now();
const decision = {
  id: 'layout-decision',
  title: 'Review the saved result',
  description: 'Layout proof fixture',
  slotId: 'layout-slot',
  type: 'engine_human_gate',
  createdAt: new Date(now).toISOString(),
  runMeta: { runId: 'layout-run', flowType: 'dev', ticketOrPr: 'LAYOUT-1' },
  actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
};
const fleet = {
  slots: [],
  machines: [],
  summary: { total: 0, ready: 0, busy: 0, held: 0, manual: 0, disabled: 0, custom: 0 },
  checkedAt: new Date(now).toISOString(),
};
const values = {
  'run.list': () => ({ runs: [] }),
  'decision.list': () => ({
    decisions: mode === 'decision' ? [decision, { ...decision, id: 'same-subject' }] : [],
  }),
  'fleet.status': () => ({
    fleet,
    observation: { status: 'ready', observedAt: now },
    canonical: true,
    projectionMatches: true,
  }),
  'pr.list': () => ({ prs: [], observation: { status: 'ready', observedAt: now } }),
  'config.projects': () => ({ projects: [] }),
  'dispatch.queue.list': () => ({ items: [] }),
  'backlog.list': () => ({ items: [] }),
  'workGraph.list': () => ({ graphs: [] }),
  'node.list': () => ({ nodes: [] }),
  'tmux.workers': () => ({ workers: [] }),
  'gateway.status': () => ({
    version: 'fixture',
    capabilities: {},
    releaseNotes: [],
    observation: { status: 'ready', observedAt: now },
    update: {
      canUpdate: false,
      updateAvailable: mode === 'update',
      branch: 'fixture',
      localSha: 'a'.repeat(40),
      remoteSha: 'b'.repeat(40),
      commitsBehind: 1,
      commitsAhead: 0,
      lastChecked: now,
      error: null,
    },
  }),
};
const server = createServer((_request, response) => {
  response.writeHead(404).end();
});
const wss = new WebSocketServer({ server });
wss.on('connection', (socket) =>
  socket.on('message', (raw) => {
    const request = JSON.parse(String(raw));
    frames.push({ at: Date.now(), method: request.method });
    const reply = { type: 'res', id: request.id, ok: true };
    if (request.method === 'auth.connect')
      reply.payload = {
        ok: true,
        clientKind: 'ui',
        authMode: 'token',
        authenticatedAt: now,
        principal: {
          id: 'layout-fixture',
          generation: 1,
          subjectKind: 'service',
          displayName: 'Layout fixture',
          roles: [{ role: 'admin', scope: { kind: 'global' } }],
        },
        capabilities: {
          httpBearerAuth: false,
          voiceInstructionFormatting: false,
          workspaceAccess: 'farm',
          resourceChanges: {
            version: 1,
            epoch,
            versionLists: false,
            observedReads: 1,
            workspaceReads: 1,
            upstreamObservers: { version: 1, methods: resourceCollectorReadMethods() },
          },
        },
      };
    else if (request.method === 'resource.observers.replace')
      reply.payload = { version: 1, sequence: request.params.sequence, applied: true };
    else if (request.method === 'gateway.ping') reply.payload = { ok: true };
    else if (mode === 'error' && request.method === 'run.list') {
      reply.ok = false;
      reply.error = { code: 'UNAVAILABLE', message: 'Fixture read is unavailable' };
    } else if (values[request.method]) {
      reply.payload = values[request.method]();
      reply.resourceState = {
        epoch,
        dependencies: (resourceDependenciesForRead(request.method, request.params) ?? []).map(
          (key) => ({ key, revision }),
        ),
      };
    } else {
      reply.ok = false;
      reply.error = {
        code: 'METHOD_NOT_FOUND',
        message: `Fixture does not supply ${request.method}`,
      };
    }
    socket.send(JSON.stringify(reply));
  }),
);
const cdp = async (...args) =>
  JSON.parse(
    (
      await execute(
        process.execPath,
        [path.join(source, 'apps/command-center/scripts/cdp.mjs'), ...args],
        {
          cwd: source,
          env: { ...process.env, FARMSLOT_UI_URL: `http://127.0.0.1:${uiPort}` },
          timeout: 60000,
          maxBuffer: 1024 * 1024,
        },
      )
    ).stdout,
  );
const save = (name, data) =>
  writeFile(path.join(output, name + '.json'), JSON.stringify(data, null, 2) + '\n');
const probe = path.join(source, 'apps/command-center/scripts/probes/stable-layout.js');
let target;
let emulation;
let emulationId = 0;
const pendingEmulation = new Map();
async function viewport(width) {
  if (!emulation) {
    const tabs = await (
      await fetch(`http://127.0.0.1:${process.env.FARMSLOT_CDP_PORT}/json`)
    ).json();
    emulation = new WebSocket(tabs.find((tab) => tab.id === target.slice(1)).webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      emulation.once('open', resolve);
      emulation.once('error', reject);
    });
    emulation.on('message', (raw) => {
      const result = JSON.parse(String(raw));
      const settle = pendingEmulation.get(result.id);
      if (settle) {
        pendingEmulation.delete(result.id);
        result.error
          ? settle.reject(new Error(result.error.message))
          : settle.resolve(result.result);
      }
    });
  }
  await new Promise((resolve, reject) => {
    const id = ++emulationId;
    pendingEmulation.set(id, { resolve, reject });
    emulation.send(
      JSON.stringify({
        id,
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width, height: 900, deviceScaleFactor: 1, mobile: false },
      }),
    );
  });
}
const inspect = async () => cdp('eval', target, '--file', probe);
async function until(accept, label) {
  const deadline = Date.now() + 30000;
  let actual;
  do {
    actual = await inspect();
    if (accept(actual)) return actual;
    await delay(100);
  } while (Date.now() < deadline);
  await save('timeout-' + label, actual);
  assert.fail(label + ': ' + JSON.stringify(actual));
}
function transition(next) {
  mode = next;
  revision++;
  const changes = [
    { family: 'decisions', scope: 'farm' },
    { family: 'runs', scope: 'farm' },
    { family: 'gateway-update', scope: 'gateway' },
  ].map((key) => ({ key, revision, kind: 'updated' }));
  for (const socket of wss.clients)
    if (socket.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          type: 'event',
          event: 'resource.changed',
          payload: { version: 1, epoch, changes },
        }),
      );
}
let vite;
let viteLog = '';
let failure;
let cleanupFailures = [];
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  vite = spawn(
    process.execPath,
    [
      path.join(source, 'node_modules/vite/bin/vite.js'),
      '--config',
      'vite.config.ts',
      '--host',
      '127.0.0.1',
    ],
    {
      cwd: path.join(source, 'apps/command-center/ui'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  vite.stdout.on('data', (data) => {
    viteLog += data;
  });
  vite.stderr.on('data', (data) => {
    viteLog += data;
  });
  const end = Date.now() + 30000;
  let ready = false;
  while (Date.now() < end) {
    try {
      ready = (await fetch(`http://127.0.0.1:${uiPort}`)).ok;
    } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') throw error;
    }
    if (ready) break;
    assert(vite.exitCode === null, viteLog);
    await delay(100);
  }
  assert(ready, viteLog);
  const opened = await cdp('goto', `http://127.0.0.1:${uiPort}/#runs`, '--new');
  target = '@' + opened.id;
  const baseline = await until((value) => value.connected && value.stripHeight === 44, 'initial');
  for (const width of [1280, 414]) {
    await viewport(width);
    const before = await inspect();
    assert.equal(before.width, width, 'The browser must use the requested CSS viewport');
    const authBefore = frames.filter((frame) => frame.method === 'auth.connect').length;
    for (const socket of wss.clients) socket.close(1012, 'Owned presentation fixture reconnect');
    await until(
      (value) =>
        value.connected &&
        frames.filter((frame) => frame.method === 'auth.connect').length > authBefore,
      'reconnect',
    );
    assert.equal(
      (await inspect()).contentTop,
      before.contentTop,
      'Reconnect cannot move the content',
    );
    for (const phase of ['decision', 'decision', 'empty', 'error', 'empty', 'update', 'empty']) {
      transition(phase);
      const current = await until(
        (value) =>
          phase === 'decision'
            ? value.top === decision.title
            : phase === 'error'
              ? value.items.some((item) => item.includes('Could not refresh runs'))
              : phase === 'update'
                ? value.items.includes('Farmslot update available')
                : !value.top &&
                  !value.items.includes('Could not refresh runs') &&
                  !value.items.includes('Farmslot update available'),
        phase,
      );
      assert.equal(current.contentTop, before.contentTop, 'A notice cannot move the content');
      assert.equal(current.stripHeight, 44);
      await save(`${width}-${phase}-${revision}`, current);
    }
    transition('decision');
    await until((value) => value.top === decision.title, 'recurrence');
    await cdp('click', target, 'farm-notification-tray >>> .bell');
    const open = await inspect();
    await save(`${width}-open`, open);
    await cdp('screenshot', target, path.join(output, `${width}-tray.png`));
    assert.equal(open.contentTop, before.contentTop);
    assert(open.panel && open.panel.left >= 0 && open.panel.right <= width, JSON.stringify(open));
    assert.equal(open.items.filter((title) => title === decision.title).length, 1);
    await cdp('screenshot', target, path.join(output, `${width}-tray.png`));
    await cdp('key', target, 'Escape');
    assert.equal((await inspect()).panel, null);
    transition('empty');
    await until((value) => !value.top, 'cleared');
  }
  const reads = frames.filter((frame) => frame.method === 'run.list').length;
  assert(reads >= 8, 'Repeated observed reads reached the real client adapter');
  await save('result', {
    result: 'PASS',
    baseline,
    requests: frames,
    limit:
      'Protocol fixture presentation only. No production gateway, native or worker acceptance.',
  });
} catch (error) {
  failure = error;
} finally {
  await writeFile(path.join(output, 'vite.log'), viteLog);
  await save('requests', frames);
  emulation?.close();
  const cleanup = await Promise.allSettled([
    target ? cdp('close', target) : Promise.resolve(),
    (async () => {
      if (vite && vite.exitCode === null) {
        vite.kill('SIGTERM');
        await new Promise((resolve) => vite.once('exit', resolve));
      }
    })(),
    (async () => {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    })(),
  ]);
  const failed = cleanup.filter((result) => result.status === 'rejected');
  cleanupFailures = failed.map((result) => result.reason);
}

if (failure || cleanupFailures.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...cleanupFailures],
    'Layout proof failed',
  );

console.log(
  JSON.stringify({
    result: 'PASS',
    widths: [1280, 414],
    observationRequests: frames.length,
    scope: 'isolated protocol fixture presentation',
  }),
);
