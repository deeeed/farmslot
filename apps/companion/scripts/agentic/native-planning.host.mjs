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
  rename,
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
  assertPlanningSourceTransition,
  digest,
  persistedQueries,
  planningSourceMutation,
  verifyNativePlanningSource,
  writePlanningSource,
} from './native-planning-fixture.mjs';
import {
  nativeResumeFitsScrollView,
  renderedNativeDisabledTarget,
} from './native-store-fixture.mjs';
import {
  assertMountedPlanningChange,
  assertObservedMemoryQueries,
  assertPlanningReadsFromRuntime,
  assertRenderedPlanningAge,
  retainedPlanningRows,
  waitForPlanningRecovery,
} from './prove-native-planning.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

test('saved-age evidence requires the selected caption and its age in rendered OCR', () => {
  assert.doesNotThrow(() =>
    assertRenderedPlanningAge(
      { text: [{ text: 'Saved projects, 19s old.', maxContrast: 12 }] },
      'projects',
    ),
  );
  for (const text of [
    [],
    [{ text: 'Saved backlog, 23s old.' }],
    [{ text: 'Saved projects,' }, { text: 'Saved backlog, 23s old.' }],
    [{ text: 'Saved projects, age unknown.' }],
  ])
    assert.throws(() => assertRenderedPlanningAge({ text }, 'projects'), /must be readable/);
  for (const maxContrast of [undefined, 1.1, 4.49])
    assert.throws(
      () =>
        assertRenderedPlanningAge(
          { text: [{ text: 'Saved projects, 19s old.', maxContrast }] },
          'projects',
        ),
      /sufficient screenshot contrast/,
    );
});

test('recovery waits for gateway startup and a backed-off client in the same cold runtime', async () => {
  let now = 0;
  const clock = { now: () => now, wait: async (ms) => (now += ms) };
  const startupCompleteAt = 75000;
  const nextClientAttemptAt = startupCompleteAt + 30000;
  const result = await waitForPlanningRecovery(
    async () => ({ startedAt: 42, online: now >= nextClientAttemptAt }),
    42,
    clock,
  );
  assert.equal(now, nextClientAttemptAt);
  assert.equal(result.online, true);
  assert.equal(result.startedAt, 42);
});

test('recovery fails closed on a new runtime, a bridge error or an expired deadline', async () => {
  await assert.rejects(
    waitForPlanningRecovery(async () => ({ startedAt: 43, online: true }), 42),
    /Recovery cannot relaunch the app/,
  );
  const bridgeError = new Error('bridge disconnected');
  await assert.rejects(
    waitForPlanningRecovery(async () => {
      throw bridgeError;
    }, 42),
    (error) => error === bridgeError,
  );
  let now = 0;
  await assert.rejects(
    waitForPlanningRecovery(async () => ({ startedAt: 42, online: false }), 42, {
      now: () => now,
      wait: async (ms) => (now += ms),
    }),
    /Controller must recover its exact gateway/,
  );
  assert.equal(now, 120000);
});

function writerCase(kind) {
  const plan = {
    sourceHead: 'a'.repeat(40),
    project: 'owned-project',
    expected: {
      graph: {
        id: 'owned-graph',
        title: 'Owned plan',
        beforeStatus: 'planning',
        afterStatus: 'paused',
      },
      queue: { id: 'owned-queue', priority: 7, afterPriority: 8 },
    },
    files: { [kind]: { path: `/owned/${kind}.json`, sha256: 'b'.repeat(64) } },
  };
  const before =
    kind === 'graph'
      ? {
          graph: {
            id: 'owned-graph',
            project: plan.project,
            title: 'Owned plan',
            status: 'planning',
          },
          nodes: [{ id: 'node' }],
          edges: [],
          gates: [],
          ledger: [],
        }
      : [
          {
            id: 'owned-queue',
            project: plan.project,
            status: 'queued',
            priority: 7,
            label: 'Owned row',
          },
          { id: 'retained-queue', project: 'other', status: 'queued', priority: 1 },
        ];
  const after = structuredClone(before);
  if (kind === 'graph') after.graph.status = 'paused';
  else after[0].priority = 8;
  return { plan, before, after };
}

test('source writers pause only the selected planning graph and update only queue priority', () => {
  const graph = writerCase('graph');
  assert.deepEqual(planningSourceMutation(graph.plan, 'graph'), {
    method: 'workGraph.pause',
    params: { graphId: 'owned-graph' },
  });
  const queue = writerCase('queue');
  assert.deepEqual(planningSourceMutation(queue.plan, 'queue'), {
    method: 'dispatch.queue.update',
    params: { itemId: 'owned-queue', priority: 8 },
  });
  assert.throws(() => planningSourceMutation(graph.plan, 'activate'));
  for (const kind of ['graph', 'queue']) {
    const { plan, before, after } = writerCase(kind);
    assert.doesNotThrow(() => assertPlanningSourceTransition(plan, kind, before, after));
    const wrong = structuredClone(after);
    if (kind === 'graph') wrong.nodes.push({ id: 'unrequested-node' });
    else wrong[1].priority++;
    assert.throws(() => assertPlanningSourceTransition(plan, kind, before, wrong));
    const foreign = structuredClone(before);
    if (kind === 'graph') foreign.graph.project = 'foreign';
    else foreign[0].project = 'foreign';
    assert.throws(() => assertPlanningSourceTransition(plan, kind, foreign, after));
  }
});

for (const kind of ['graph', 'queue']) {
  test(`mounted ${kind} proof refuses unrelated reads, old revisions and mismatched saved data`, () => {
    const { plan, before: sourceBefore, after: sourceAfter } = writerCase(kind);
    const queryId = persistedQueries[kind];
    const method = queryId.slice(0, queryId.indexOf(':'));
    const collection = kind === 'graph' ? 'work-graphs' : 'dispatch-queue';
    const data = (source) => (kind === 'graph' ? { graphs: [source] } : { items: source });
    const before = {
      state: {
        startedAt: 100,
        connectionGeneration: 1,
        workspaceKey: 'current-owner',
        connectionProfileId: 'private-profile',
        online: true,
      },
      result: { integrity: 'ok', rows: [{ id: queryId, data: data(sourceBefore) }] },
    };
    const after = {
      state: { ...before.state },
      result: { integrity: 'ok', rows: [{ id: queryId, data: data(sourceAfter) }] },
    };
    const read = (payload, revision, completedAt) => ({
      payloadSha256: digest(JSON.stringify(payload)),
      completedAt,
      resourceState: {
        epoch: 'live-epoch',
        dependencies: [{ key: { family: 'planning', collection }, revision }],
      },
    });
    const priorWire = {
      startId: 'owned-proxy',
      successfulReads: { [method]: 1 },
      lastObservedReads: { [method]: read(before.result.rows[0].data, 1, 150) },
    };
    const wire = {
      startId: 'owned-proxy',
      successfulReads: { [method]: 2 },
      lastObservedReads: { [method]: read(after.result.rows[0].data, 2, 250) },
    };
    // The app may finish its legitimate read before the writer's disk receipt is recorded.
    const writer = {
      kind,
      method: planningSourceMutation(plan, kind).method,
      sourceHead: plan.sourceHead,
      path: plan.files[kind].path,
      before: plan.files[kind].sha256,
      requestedAt: 200,
      recordedAt: 300,
    };
    const input = { plan, kind, before, after, writer, priorWire, wire };
    const check = (value) =>
      assertMountedPlanningChange(
        value.plan,
        value.kind,
        value.before,
        value.after,
        value.writer,
        value.priorWire,
        value.wire,
      );
    assert.doesNotThrow(() => check(input));
    for (const change of [
      (v) => {
        v.wire.successfulReads[method] = 1;
      },
      (v) => {
        v.wire.lastObservedReads[method].resourceState.dependencies[0].revision = 1;
      },
      (v) => {
        v.wire.lastObservedReads[method].resourceState.epoch = 'other-epoch';
      },
      (v) => {
        v.wire.lastObservedReads[method].resourceState.dependencies[0].key.collection = 'unrelated';
      },
      (v) => {
        v.wire.lastObservedReads[method].completedAt = 199;
      },
      (v) => {
        v.priorWire.lastObservedReads[method].completedAt = 50;
      },
      (v) => {
        v.wire.lastObservedReads[method].payloadSha256 = 'wrong-payload';
      },
      (v) => {
        v.writer.sourceHead = 'b'.repeat(40);
      },
      (v) => {
        v.after.state.startedAt++;
      },
      (v) => {
        v.after.state.connectionGeneration++;
      },
      (v) => {
        v.after.state.workspaceKey = 'other-owner';
      },
      (v) => {
        v.after.state.online = false;
      },
      (v) => {
        v.wire.startId = 'other-proxy';
      },
      (v) => {
        v.after.result.rows[0].data = structuredClone(before.result.rows[0].data);
        v.wire.lastObservedReads[method].payloadSha256 = digest(
          JSON.stringify(v.after.result.rows[0].data),
        );
      },
    ]) {
      const invalid = structuredClone(input);
      change(invalid);
      assert.throws(() => check(invalid));
    }
  });
}

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
test('planning retention requires every collection and bounds the whole graph cohort', () => {
  const ids = [
    'backlog.list:{"includeArchived":true}',
    'roadmap.list:{"includeArchived":true}',
    'config.projects:{}',
    'dispatch.queue.list:{}',
    'workGraph.list:{"includeArchived":true}',
  ];
  const rows = ids.map((id, index) => ({
    id,
    observedAt: 1700000000000 + index,
    data: { source: id },
    bytes: 20,
  }));
  const result = { integrity: 'ok', rows };
  assert.deepEqual(Object.keys(retainedPlanningRows(result)).sort(), [
    'backlog',
    'graph',
    'projects',
    'queue',
    'roadmap',
  ]);
  for (const id of ids)
    assert.throws(
      () => retainedPlanningRows({ ...result, rows: rows.filter((row) => row.id !== id) }),
      /Actual UI did not persist/,
    );
  assert.throws(
    () =>
      retainedPlanningRows({
        ...result,
        rows: [
          ...rows,
          {
            id: 'workGraph.list:{"project":"other"}',
            observedAt: 1700000000000,
            data: {},
            bytes: 2 * 1024 * 1024,
          },
        ],
      }),
    /workGraph.list aggregate exceeds/,
  );
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

test('initial-view reads belong to the current app; preboot source probes do not', () => {
  const snapshot = { startedAt: 1700000000100 };
  const wire = {
    successfulReads: { 'backlog.list': 1 },
    lastObservedReads: { 'backlog.list': { completedAt: 1700000000200 } },
  };
  assert.doesNotThrow(() => assertPlanningReadsFromRuntime(snapshot, wire, ['backlog.list']));
  assert.throws(
    () =>
      assertPlanningReadsFromRuntime(
        snapshot,
        {
          ...wire,
          lastObservedReads: { 'backlog.list': { completedAt: 1700000000000 } },
        },
        ['backlog.list'],
      ),
    /pre-app reply/,
  );
  assert.throws(
    () =>
      assertPlanningReadsFromRuntime(
        snapshot,
        {
          ...wire,
          successfulReads: {},
        },
        ['backlog.list'],
      ),
    /Missing observed app read/,
  );
  assert.throws(
    () =>
      assertPlanningReadsFromRuntime(
        snapshot,
        {
          ...wire,
          lastObservedReads: {},
        },
        ['backlog.list'],
      ),
    /pre-app reply/,
  );
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
    let persisted;
    t.after(async () => {
      await persisted;
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
        if (request.method === 'auth.connect' && request.params.clientKind !== 'ui') {
          peer.send(
            JSON.stringify({
              type: 'res',
              id: request.id,
              ok: false,
              error: { code: 'AUTH_INVALID_CLIENT' },
            }),
          );
          return;
        }
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
          persisted = delay(40).then(async () => {
            await writeFile(`${file}.tmp`, JSON.stringify([item]));
            await rename(`${file}.tmp`, file);
          });
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

for (const kind of ['graph', 'queue']) {
  test(
    `the ${kind} writer records actual RPC and disk bytes without rewriting server fields`,
    { timeout: 4000 },
    async (t) => {
      const directory = await realpath(
        await mkdtemp(path.join(os.tmpdir(), 'd07-planning-writer-')),
      );
      const artifacts = path.join(directory, 'artifacts');
      await mkdir(artifacts);
      const file = path.join(directory, kind + '.json');
      const credentialFile = path.join(directory, 'source.json');
      const fixture = writerCase(kind);
      const stamp = { kind: 'principal', principalId: 'source-admin' };
      if (kind === 'graph') {
        fixture.before.originator = stamp;
        fixture.after.originator = stamp;
      } else {
        fixture.before[0].originator = stamp;
        fixture.after[0].originator = stamp;
      }
      const publicResult = structuredClone(kind === 'graph' ? fixture.after : fixture.after[0]);
      delete publicResult.originator;
      const credential = Buffer.from(JSON.stringify({ secret: 'PRIVATE_SOURCE_TEST_CREDENTIAL' }));
      const before = Buffer.from(JSON.stringify(fixture.before));
      const after = Buffer.from(JSON.stringify(fixture.after));
      await writeFile(file, before);
      await writeFile(credentialFile, credential, { mode: 0o600 });
      const plan = {
        ...fixture.plan,
        farmRoot: directory,
        projectsDir: directory,
        files: { [kind]: { path: file, sha256: digest(before) } },
        sourceWriter: {
          url: 'ws://127.0.0.1:7914',
          credentialFile,
          credentialSha256: digest(credential),
          principalId: 'source-admin',
        },
      };
      const server = createServer();
      const sockets = new WebSocketServer({ server });
      const peers = new Set();
      const methods = [];
      let persisted;
      t.after(async () => {
        await persisted;
        for (const peer of peers) peer.terminate();
        await new Promise((resolve) => sockets.close(resolve));
        if (server.listening) await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      });
      sockets.on('connection', (peer) => {
        peers.add(peer);
        peer.on('close', () => peers.delete(peer));
        peer.on('message', async (bytes) => {
          const request = JSON.parse(String(bytes));
          methods.push(request.method);
          if (request.method === 'auth.connect' && request.params.clientKind !== 'ui') {
            peer.send(
              JSON.stringify({
                type: 'res',
                id: request.id,
                ok: false,
                error: { code: 'AUTH_INVALID_CLIENT' },
              }),
            );
            return;
          }
          if (request.method === 'auth.connect') {
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
            return;
          }
          assert.deepEqual(
            { method: request.method, params: request.params },
            planningSourceMutation(plan, kind),
          );
          if (kind === 'graph') {
            await writeFile(file, after);
            peer.send(
              JSON.stringify({
                type: 'res',
                id: request.id,
                ok: true,
                payload: { graph: publicResult },
              }),
            );
          } else {
            // The real priority handler acknowledges readable memory before queued persistence.
            persisted = delay(40).then(async () => {
              await writeFile(`${file}.tmp`, after);
              await rename(`${file}.tmp`, file);
            });
            peer.send(
              JSON.stringify({
                type: 'res',
                id: request.id,
                ok: true,
                payload: { item: publicResult },
              }),
            );
          }
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(7914, '127.0.0.1', resolve);
      });
      const foreign = structuredClone(fixture.before);
      if (kind === 'graph') foreign.graph.project = 'foreign';
      else foreign[0].project = 'foreign';
      const foreignBytes = Buffer.from(JSON.stringify(foreign));
      await writeFile(file, foreignBytes);
      plan.files[kind].sha256 = digest(foreignBytes);
      await assert.rejects(
        () => writePlanningSource(plan, kind, artifacts),
        (error) => error.code === 'ERR_ASSERTION',
      );
      assert.deepEqual(methods, [], 'A foreign source must be refused before authentication');
      await writeFile(file, before);
      plan.files[kind].sha256 = digest(before);
      const receipt = await writePlanningSource(plan, kind, artifacts);
      assert.deepEqual(methods, ['auth.connect', planningSourceMutation(plan, kind).method]);
      assert.deepEqual(await readFile(file), after);
      assert.equal(receipt.before, digest(before));
      assert.equal(receipt.after, digest(after));
      assert(receipt.requestedAt > 0 && receipt.recordedAt >= receipt.requestedAt);
      const raw = await readFile(path.join(artifacts, `d07-writer-${kind}.json`), 'utf8');
      assert(!raw.includes('PRIVATE_SOURCE_TEST_CREDENTIAL'));
      await assert.rejects(() => writePlanningSource(plan, kind, artifacts), /already consumed/);
    },
  );
}

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
    const graphPayload = { graphs: [] };
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
        if (request.method === 'workGraph.list') {
          response.payload = graphPayload;
          response.resourceState = stamp('host-epoch', [
            {
              key: { family: 'planning', collection: 'work-graphs' },
              revision: 4,
            },
          ]);
        }
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
    await request('workGraph.list', { kind: 'no-payload' });
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
    assert.equal(rejected.successfulReads['workGraph.list'] ?? 0, 0);
    assert.equal(
      rejected.successfulReads['prWatch.list'] ?? 0,
      0,
      'Invalid/unstamped/error replies are not successful observed reads',
    );
    await request('prWatch.list');
    await request('workGraph.list');
    await request('config.projects');
    const successful = await countsAt(2);
    assert.equal(successful.successfulReads['prWatch.list'], 1);
    assert.equal(successful.successfulReads['workGraph.list'], 1);
    assert.equal(
      successful.lastObservedReads['workGraph.list'].payloadSha256,
      createHash('sha256').update(JSON.stringify(graphPayload)).digest('hex'),
    );
    assert.equal(successful.lastObservedReads['prWatch.list'].resourceState.epoch, 'host-epoch');
    assert.equal(
      successful.lastObservedReads['prWatch.list'].payloadSha256,
      createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    );
    assert(!JSON.stringify(successful).includes('NEVER_RETAIN_'));
  },
);
