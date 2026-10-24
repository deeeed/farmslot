// Explicit host guards, outside device execution and the default test suite.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import WebSocket, { WebSocketServer } from 'ws';

import {
  digest,
  verifyNativePlanningSource,
  writePlanningSource,
} from './native-planning-fixture.mjs';
import {
  nativeResumeFitsScrollView,
  renderedNativeDisabledTarget,
} from './native-store-fixture.mjs';
import { assertObservedMemoryQueries } from './prove-native-planning.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

test('source pins verify actual committed bytes and modes before any native preparation', async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'd07-source-pin-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_NAMESPACE',
    'GIT_PREFIX',
  ])
    delete env[name];
  const execute = promisify(execFile);
  const git = async (...args) =>
    (
      await execute(
        'git',
        [
          '-C',
          directory,
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'user.name=Source fixture',
          '-c',
          'user.email=source@example.invalid',
          ...args,
        ],
        { env },
      )
    ).stdout;
  await git('init', '--initial-branch=fixture-source');
  const file = path.join(directory, 'source.ts');
  const bytes = 'export const value = 7;\n';
  await writeFile(file, bytes, { mode: 0o644 });
  const executable = path.join(directory, 'run.sh');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await git('add', '--', 'source.ts', 'run.sh');
  await git('commit', '-m', 'test: establish source fixture');
  const head = (await git('rev-parse', 'HEAD')).trim();
  const verified = await verifyNativePlanningSource(directory, head);
  assert.equal(verified.sourceHead, head);
  assert.equal(verified.fileCount, 2);
  assert.match(verified.sourceTreeSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    () => verifyNativePlanningSource(directory, '0'.repeat(40)),
    /Source commit changed/,
  );
  await assert.rejects(() => verifyNativePlanningSource(directory, 'short'), /full source commit/);

  // A stat cache or assume-unchanged flag cannot hide different source bytes.
  await git('update-index', '--assume-unchanged', '--', 'source.ts');
  await writeFile(file, 'export const value = 9;\n');
  await assert.rejects(
    () => verifyNativePlanningSource(directory, head),
    /Source bytes drift: source.ts/,
  );
  await writeFile(file, bytes);
  await chmod(file, 0o755);
  await assert.rejects(
    () => verifyNativePlanningSource(directory, head),
    /Source mode drift: source.ts/,
  );
  await chmod(file, 0o644);
  await writeFile(path.join(directory, 'untracked.ts'), 'export const extra = true;\n');
  await assert.rejects(() => verifyNativePlanningSource(directory, head), /Untracked source files/);
  await rm(path.join(directory, 'untracked.ts'));
  await rm(file);
  await symlink(executable, file);
  await assert.rejects(
    () => verifyNativePlanningSource(directory, head),
    /Source file is not regular/,
  );
  await rm(file);
  await writeFile(file, bytes, { mode: 0o644 });
  assert.deepEqual(await verifyNativePlanningSource(directory, head), verified);
});

const scene = () => ({
  nodes: [
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      rect: { x: 0, y: 100, width: 402, height: 700 },
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'Button',
      identifier: 'mark-ready',
      enabled: false,
      rect: { x: 12, y: 276, width: 378, height: 44 },
    },
  ],
});
const image = () => ({
  width: 804,
  height: 1748,
  text: [{ text: 'Mark ready', x: 0.2, y: 0.64, width: 0.4, height: 0.04 }],
});

test('transport success cannot replace actual canonical query readiness', () => {
  const resourceState = {
    epoch: 'current',
    dependencies: [{ key: { family: 'pr-automation', scope: 'farm' }, revision: 2 }],
  };
  const current = {
    id: 'prWatch.list:{}',
    status: 'ready',
    hasData: true,
    persisted: false,
    resourceState,
  };
  const frame = (state) => ({ domainObservations: { 'prWatch.list': state } });
  const wire = { lastObservedReads: { 'prWatch.list': { resourceState } } };
  assert.doesNotThrow(() => assertObservedMemoryQueries(frame(current), wire, ['prWatch.list']));
  for (const change of [
    { status: 'loading' },
    { status: 'stale' },
    { hasData: false },
    { persisted: true },
    { id: 'prWatch.list:{"id":"other"}' },
    { resourceState: { ...resourceState, epoch: 'retired' } },
  ])
    assert.throws(() =>
      assertObservedMemoryQueries(frame({ ...current, ...change }), wire, ['prWatch.list']),
    );
  assert.throws(() => assertObservedMemoryQueries({}, wire, ['prWatch.list']));
});

test('a disabled planning point requires full ancestor containment and a paired rendered label', () => {
  assert.deepEqual(renderedNativeDisabledTarget(scene(), image(), 'mark-ready', 'Mark ready'), {
    x: 201,
    y: 298,
  });
  const clipped = scene();
  clipped.nodes[1].rect = { x: 0, y: 264, width: 402, height: 475 };
  clipped.nodes[2].rect.y = 231.333;
  assert.equal(
    nativeResumeFitsScrollView(clipped, 'mark-ready'),
    false,
    'The retained boot24 partial overlap is insufficient',
  );
  assert.throws(() => renderedNativeDisabledTarget(clipped, image(), 'mark-ready', 'Mark ready'));
  assert.throws(
    () =>
      renderedNativeDisabledTarget(scene(), { ...image(), text: [] }, 'mark-ready', 'Mark ready'),
    'A stale tail screenshot cannot authorize a press',
  );
  const cycle = scene();
  cycle.nodes[1].parentIndex = 2;
  assert.equal(nativeResumeFitsScrollView(cycle, 'mark-ready'), false);
  const absent = scene();
  absent.nodes[2].parentIndex = 99;
  assert.equal(nativeResumeFitsScrollView(absent, 'mark-ready'), false);
  const enabled = scene();
  enabled.nodes[2].enabled = true;
  assert.throws(() => renderedNativeDisabledTarget(enabled, image(), 'mark-ready', 'Mark ready'));
  const duplicated = scene();
  duplicated.nodes.push({ ...duplicated.nodes[2], index: 3 });
  assert.throws(() =>
    renderedNativeDisabledTarget(duplicated, image(), 'mark-ready', 'Mark ready'),
  );
  assert.throws(() =>
    renderedNativeDisabledTarget(scene(), { ...image(), height: 1800 }, 'mark-ready', 'Mark ready'),
  );
  const outsideViewport = scene();
  outsideViewport.nodes[1].rect.height = 900;
  outsideViewport.nodes[2].rect.y = 850;
  assert.throws(
    () =>
      renderedNativeDisabledTarget(
        outsideViewport,
        { ...image(), text: [{ text: 'Mark ready', x: 0.2, y: 0.001, width: 0.4, height: 0.016 }] },
        'mark-ready',
        'Mark ready',
      ),
    'An oversized ancestor cannot admit a partially offscreen control',
  );
  assert.throws(
    () =>
      renderedNativeDisabledTarget(
        scene(),
        { ...image(), text: [{ text: 'Mark ready', x: 0.2, y: 0.61, width: 0.4, height: 0.1 }] },
        'mark-ready',
        'Mark ready',
      ),
    'A matching label center cannot admit a label outside the control bounds',
  );
});

test(
  'the backlog source writer uses the owning API and preserves its server-managed update',
  { timeout: 4000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'd07-owning-backlog-')));
    const artifacts = path.join(directory, 'artifacts');
    await mkdir(artifacts);
    const file = path.join(directory, 'backlog.json');
    const credentialFile = path.join(directory, 'source.json');
    const before = Buffer.from(
      JSON.stringify([{ id: 'owned-item', title: 'Before', status: 'candidate' }]),
    );
    const credential = Buffer.from(JSON.stringify({ secret: 'PRIVATE_SOURCE_TEST_CREDENTIAL' }));
    await writeFile(file, before);
    await writeFile(credentialFile, credential, { mode: 0o600 });
    const server = createServer();
    const source = new WebSocketServer({ server });
    const sockets = new Set();
    const methods = [];
    t.after(async () => {
      for (const peer of sockets) peer.terminate();
      await new Promise((resolve) => source.close(resolve));
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    source.on('connection', (peer) => {
      sockets.add(peer);
      peer.on('close', () => sockets.delete(peer));
      peer.on('message', async (bytes) => {
        const request = JSON.parse(String(bytes));
        methods.push(request.method);
        if (request.method === 'auth.connect')
          peer.send(
            JSON.stringify({
              type: 'res',
              id: request.id,
              ok: true,
              payload: {
                principal: {
                  id: 'source-admin',
                  roles: [{ role: 'admin', scope: { kind: 'global' } }],
                },
              },
            }),
          );
        else if (request.method === 'backlog.update') {
          assert.deepEqual(request.params, { itemId: 'owned-item', title: 'After' });
          const item = {
            id: 'owned-item',
            title: 'After',
            status: 'candidate',
            serverManaged: 'must-survive',
          };
          await writeFile(file, JSON.stringify([item]));
          peer.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: { item } }));
        } else assert.fail(`Unexpected source method: ${request.method}`);
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(7914, '127.0.0.1', resolve);
    });
    const plan = {
      sourceHead: 'a'.repeat(40),
      farmRoot: directory,
      projectsDir: directory,
      files: { backlog: { path: file, sha256: digest(before) } },
      expected: { backlog: { id: 'owned-item', before: 'Before', after: 'After' } },
      sourceWriter: {
        url: 'ws://127.0.0.1:7914',
        credentialFile,
        credentialSha256: digest(credential),
        principalId: 'source-admin',
      },
    };
    await writePlanningSource(plan, 'backlog', artifacts);
    assert.deepEqual(methods, ['auth.connect', 'backlog.update']);
    assert.equal(JSON.parse(await readFile(file, 'utf8'))[0].serverManaged, 'must-survive');
    const receipt = await readFile(path.join(artifacts, 'd07-writer-backlog.json'), 'utf8');
    assert.equal(JSON.parse(receipt).method, 'backlog.update');
    assert.equal(JSON.parse(receipt).sourceHead, plan.sourceHead);
    assert(!receipt.includes('PRIVATE_SOURCE_TEST_CREDENTIAL'));
    await assert.rejects(writePlanningSource(plan, 'backlog', artifacts), /already consumed/);
  },
);

test(
  'the passive proxy counts only successful negotiated observed replies and retains no private bytes',
  { timeout: 4500 },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'd07-proxy-host-'));
    const server = createServer();
    const source = new WebSocketServer({ server });
    let proxy;
    let client;
    const sockets = new Set();
    t.after(async () => {
      client?.terminate();
      if (proxy && proxy.exitCode === null) {
        proxy.kill('SIGTERM');
        await once(proxy, 'exit');
      }
      for (const peer of sockets) peer.terminate();
      await new Promise((resolve) => source.close(resolve));
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    const stamp = (
      epoch = 'host-epoch',
      dependencies = [{ key: { family: 'pr-automation', scope: 'farm' }, revision: 3 }],
    ) => ({ epoch, dependencies });
    const payload = { monitors: [], privateReply: 'NEVER_RETAIN_PAYLOAD' };
    source.on('connection', (peer) => {
      sockets.add(peer);
      peer.on('close', () => sockets.delete(peer));
      peer.on('message', (bytes) => {
        const request = JSON.parse(String(bytes));
        if (request.method === 'auth.connect') {
          peer.send(
            JSON.stringify({
              type: 'res',
              id: request.id,
              ok: true,
              payload: { capabilities: { resourceChanges: { version: 1, epoch: 'host-epoch' } } },
            }),
          );
          return;
        }
        const response = { type: 'res', id: request.id, ok: true, payload, resourceState: stamp() };
        if (request.params?.kind === 'error') {
          response.ok = false;
          response.error = { code: 'REFUSED', message: 'NEVER_RETAIN_ERROR' };
        }
        if (request.params?.kind === 'no-stamp') delete response.resourceState;
        if (request.params?.kind === 'wrong-epoch') response.resourceState = stamp('retired-epoch');
        if (request.params?.kind === 'empty-deps') response.resourceState = stamp('host-epoch', []);
        if (request.params?.kind === 'bad-deps')
          response.resourceState = stamp('host-epoch', [null]);
        if (request.params?.kind === 'no-payload') delete response.payload;
        peer.send(JSON.stringify(response));
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(7914, '127.0.0.1', resolve);
    });
    proxy = spawn(
      process.execPath,
      [path.join(root, 'apps/companion/scripts/agentic/prove-native-store.mjs'), 'proxy-server'],
      {
        cwd: root,
        env: {
          ...process.env,
          GATEWAY_PORT: '7914',
          FARMSLOT_NATIVE_STORE_PROXY_PORT: '7917',
          FARMSLOT_NATIVE_STORE_PROXY_DIR: directory,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let diagnostics = '';
    proxy.stderr.on('data', (bytes) => {
      diagnostics += bytes;
    });
    const deadline = Date.now() + 2000;
    while (true) {
      assert.equal(proxy.exitCode, null, diagnostics);
      try {
        JSON.parse(await readFile(path.join(directory, 'ready.json'), 'utf8'));
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      assert(Date.now() < deadline, 'Owned proxy readiness deadline');
      await delay(5);
    }
    client = new WebSocket('ws://127.0.0.1:7917');
    await once(client, 'open');
    const pending = new Map();
    client.on('message', (bytes) => {
      const frame = JSON.parse(String(bytes));
      pending.get(frame.id)?.(frame);
      pending.delete(frame.id);
    });
    let id = 0;
    const request = (method, params = {}, observed = true) =>
      new Promise((resolve) => {
        const key = String(++id);
        pending.set(key, resolve);
        client.send(
          JSON.stringify({
            type: 'req',
            id: key,
            method,
            params,
            ...(observed ? { resourceRead: { version: 1 } } : {}),
          }),
        );
      });
    await request('auth.connect', { token: 'NEVER_RETAIN_AUTH' }, false);
    for (const kind of ['error', 'no-stamp', 'wrong-epoch', 'empty-deps', 'bad-deps', 'no-payload'])
      await request('prWatch.list', { kind, privateParam: 'NEVER_RETAIN_PARAMS' });
    await request('prWatch.list', {}, false);
    await request('config.projects');
    async function countsAt(barriers) {
      const end = Date.now() + 1000;
      do {
        const value = JSON.parse(await readFile(path.join(directory, 'counts.json'), 'utf8'));
        if ((value.successfulReads['config.projects'] ?? 0) >= barriers) return value;
        await delay(5);
      } while (Date.now() < end);
      assert.fail('Observe the actual persisted response barrier');
    }
    const rejected = await countsAt(1);
    assert.equal(
      rejected.successfulReads['prWatch.list'] ?? 0,
      0,
      'Invalid/unstamped/error replies are not successful observed reads',
    );
    await request('prWatch.list');
    await request('config.projects');
    const successful = await countsAt(2);
    assert.equal(successful.successfulReads['prWatch.list'], 1);
    assert.equal(successful.lastObservedReads['prWatch.list'].resourceState.epoch, 'host-epoch');
    assert.equal(
      successful.lastObservedReads['prWatch.list'].payloadSha256,
      createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    );
    assert(!JSON.stringify(successful).includes('NEVER_RETAIN_'));
  },
);
