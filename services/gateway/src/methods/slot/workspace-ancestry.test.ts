import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mock, test } from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import type { ExecResult } from '@farmslot/protocol';
import { withProjectSources } from '@farmslot/slot-config';

await import('../../runtime/mock-pty.test-support.js');
const actual = await import('../../host-services/read-command.js');
const calls: string[] = [];
let outcome: ExecResult = { exitCode: 0, stdout: '', stderr: '' };
let paused: Promise<ExecResult> | undefined;
mock.module('../../host-services/read-command.js', {
  namedExports: {
    ...actual,
    readSlotCommand: async (_vars: unknown, command: string) => {
      calls.push(command);
      return paused ?? { ...outcome };
    },
  },
});
const path: string = './workspace-ancestry.js?unit-policy';
const {
  readDefaultWorkspaceAncestry: read,
  invalidatePassiveDefaultAncestry: invalidate,
}: typeof import('./workspace-ancestry.js') = await import(path);
const { makeVars } = await import('../../runners/test-fixtures.js');
const { withSlotCommandExecutor } = await import('../../core/exec-scope.js');
const { registerNode, unregisterByWs } = await import('../../fleet/machine-registry.js');
const { sourceTestLock, sourceTestMaterialization } =
  await import('../../sources/source.test-support.js');
type Query = Parameters<typeof read>[0];
let id = 0;
const query = (): Query => ({
  vars: makeVars({ slotId: `ancestry-unit-${++id}` }),
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  originKey: 'origin',
  passive: true,
  timeoutMs: 5000,
  metadata: { version: 'same metadata', ancestryCacheable: true },
  ownership: {
    epoch: 1,
    currentRunId: null,
    cleanupRunId: null,
    handoffRunId: null,
    recoveryId: null,
  },
});

test('positive cache pins both commits and hits do not extend the ten-minute expiry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const q = query(),
    before = calls.length;
  await read(q);
  t.mock.timers.tick(590000);
  await read(q);
  assert.equal(calls.length - before, 1);
  assert.match(
    calls.at(-1) ?? '',
    new RegExp(`merge-base --is-ancestor '${q.headSha}' '${q.baseSha}'`),
  );
  t.mock.timers.tick(10001);
  await read(q);
  assert.equal(calls.length - before, 2, 'a hit cannot postpone the original expiry');
});

test('non-ancestor and failed commands retain every query and its result', async () => {
  for (const exitCode of [1, 124, 128]) {
    const q = query(),
      before = calls.length;
    outcome = { exitCode, stdout: 'out', stderr: 'err' };
    assert.deepEqual(await read(q), outcome);
    assert.deepEqual(await read(q), outcome);
    assert.equal(calls.length - before, 2);
  }
  outcome = { exitCode: 0, stdout: '', stderr: '' };
});

test('HEAD, base, metadata, auth, worktree and ownership changes invalidate positives', async () => {
  const changes: Array<(q: Query) => Query> = [
    (q) => ({ ...q, headSha: 'c'.repeat(40) }),
    (q) => ({ ...q, baseSha: 'd'.repeat(40) }),
    (q) => ({ ...q, metadata: { version: 'new metadata', ancestryCacheable: true } }),
    (q) => ({ ...q, originKey: 'new auth' }),
    (q) => ({ ...q, vars: { ...q.vars, remoteRepo: '/changed/worktree' } }),
    (q) => ({ ...q, ownership: { ...q.ownership, epoch: 2 } }),
  ];
  for (const change of changes) {
    const q = query();
    await read(q);
    const before = calls.length;
    await read(change(q));
    assert.equal(calls.length, before + 1);
  }
  const q = query();
  await read(q);
  const before = calls.length;
  invalidate(q.vars.slotId);
  await read(q);
  assert.equal(calls.length, before + 1);
});

test('missing metadata and unsupported graphs cannot use or revive a positive', async () => {
  for (const metadata of [undefined, { version: 'same metadata', ancestryCacheable: false }]) {
    const q = query();
    await read(q);
    const before = calls.length;
    await read({ ...q, metadata });
    await read({ ...q, metadata });
    await read(q);
    assert.equal(calls.length - before, 3);
  }
});

test('acting, recovery, owned and source-bound reads retain the fresh HEAD command', async () => {
  const q = query();
  await read(q);
  let before = calls.length;
  await read({ ...q, passive: false });
  await read({ ...q, timeoutMs: 120000 });
  assert.equal(calls.length - before, 2);
  assert.match(calls.at(-1) ?? '', /merge-base --is-ancestor HEAD /);
  before = calls.length;
  await withSlotCommandExecutor(
    async () => assert.fail('mocked read boundary'),
    async () => {
      await read(q);
      await read(q);
    },
  );
  const lock = sourceTestLock('fixture');
  await withProjectSources(
    {
      project: 'demo',
      pack: lock.packBindings.demo,
      packs: lock.packBindings,
      materialization: sourceTestMaterialization(lock, 'gateway'),
    },
    async () => {
      await read(q);
      await read(q);
    },
  );
  assert.equal(calls.length - before, 4);
});

test('a replacement connection cannot reuse or receive the old flight positive', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const pairs: Array<{ client: WebSocket; socket: WebSocket }> = [];
  t.after(async () => {
    for (const pair of pairs) {
      unregisterByWs(pair.socket);
      pair.client.terminate();
      pair.socket.terminate();
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const connect = async () => {
    const accepted = new Promise<WebSocket>((resolve) => server.once('connection', resolve));
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const opened = once(client, 'open');
    const socket = await accepted;
    await opened;
    pairs.push({ client, socket });
    return socket;
  };
  const q = query();
  q.vars = { ...q.vars, machine: 'ancestry-connection-fixture', host: 'remote.invalid' };
  registerNode(q.vars.machine, 1, await connect());
  await read(q);
  const before = calls.length;
  registerNode(q.vars.machine, 2, await connect());
  await read(q);
  assert.equal(calls.length, before + 1);
  invalidate(q.vars.slotId);
  let release: (value: ExecResult) => void = () => assert.fail('missing release');
  paused = new Promise((resolve) => {
    release = resolve;
  });
  const pending = read(q);
  registerNode(q.vars.machine, 3, await connect());
  release(outcome);
  await pending;
  paused = undefined;
  const count = calls.length;
  await read(q);
  assert.equal(calls.length, count + 1, 'old flight must not populate a replacement cache');
});

test('invalidating an outstanding query prevents its completion from restoring a positive', async () => {
  const q = query();
  let release: (value: ExecResult) => void = () => assert.fail('missing release');
  paused = new Promise((resolve) => {
    release = resolve;
  });
  const pending = read(q);
  invalidate(q.vars.slotId);
  release({ exitCode: 0, stdout: '', stderr: '' });
  try {
    await pending;
  } finally {
    paused = undefined;
  }
  const before = calls.length;
  await read(q);
  assert.equal(calls.length, before + 1, 'the invalidated flight must not seed a later hit');
});
