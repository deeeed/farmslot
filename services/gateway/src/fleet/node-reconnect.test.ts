import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import type { SlotVars } from '../core/config.js';
import { slotWriteFile } from '../core/slot-io.js';
import { makeRun } from '../methods/run/test-fixtures.js';
import { releasePrepareSentinel } from '../methods/slot/prepare-sentinel.js';
import { captureRunSourceOwnerFence } from '../sources/run-fence.js';

import { registerNode, unregisterByWs } from './machine-registry.js';
import {
  handleNodeResponse,
  nodeExec,
  NodeTransportUnavailableError,
  withNodeReconnectWait,
} from './node-rpc.js';

test('pipeline execution and file writes wait past 15s and send once with the original command timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const machine = 'reconnecting-pipeline';
  const sends: Array<{ method: string; params: Record<string, unknown> }> = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    send(raw: string, callback?: () => void) {
      const { id, method, params } = JSON.parse(raw);
      sends.push({ method, params });
      callback?.();
      handleNodeResponse(id, true, { exitCode: 0, stdout: 'ready', stderr: '' });
    },
  });
  const ws = socket as WebSocket;
  t.after(() => unregisterByWs(ws));
  const pending = withNodeReconnectWait(
    () => nodeExec(machine, 'prepare', '/source', { timeout: 30_000, noRetry: true }),
    () => {},
  );
  const write = withNodeReconnectWait(
    () =>
      slotWriteFile({ host: 'remote.invalid', machine, sshTarget: '' }, '/source/TASK.md', 'task'),
    () => {},
  );
  t.mock.timers.tick(20_000);
  await Promise.resolve();
  assert.equal(sends.length, 0);
  registerNode(machine, 1, ws);
  t.mock.timers.tick(100);
  assert.equal((await pending).exitCode, 0);
  await write;
  assert.deepEqual(
    sends.map((request) => request.method),
    ['exec', 'fs.write'],
  );
  assert.equal(sends[0].params.timeout, 30_000);
});

test('pipeline offline wait expires at two minutes without sending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const pending = withNodeReconnectWait(
    () => nodeExec('offline-pipeline', 'dispatch'),
    () => {},
  );
  const rejected = assert.rejects(pending, (error: unknown) => {
    assert(error instanceof NodeTransportUnavailableError);
    assert.equal(error.reason, 'not-connected');
    assert.match(error.message, /120000ms/);
    return true;
  });
  t.mock.timers.tick(120_000);
  await rejected;
});

for (const change of ['cancel', 'generation'] as const) {
  test(`${change} during pipeline reconnect refuses the pending command`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const run = makeRun({ engineState: { generation: 1 } });
    const current = captureRunSourceOwnerFence(run, () => run, 'Run ownership changed');
    const pending = withNodeReconnectWait(
      () => nodeExec('cancelled-pipeline', 'write-task'),
      () => {
        current();
      },
    );
    const rejected = assert.rejects(pending, /Run ownership changed/);
    if (change === 'cancel') run.status = 'cancelled';
    else run.engineState = { generation: 2 };
    t.mock.timers.tick(100);
    await rejected;
  });
}

test('run cancellation after the ready-node read prevents the deferred send', async (t) => {
  const machine = 'ready-cancelled-pipeline';
  let sent = 0;
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    send(_raw: string, callback?: () => void) {
      sent++;
      callback?.();
    },
  });
  const ws = socket as WebSocket;
  registerNode(machine, 1, ws);
  t.after(() => unregisterByWs(ws));
  const run = makeRun();
  const current = captureRunSourceOwnerFence(run, () => run, 'Run ownership changed');
  const pending = withNodeReconnectWait(
    () => nodeExec(machine, 'dispatch'),
    () => {
      current();
    },
  );
  run.status = 'cancelled';
  await assert.rejects(pending, /Run ownership changed/);
  assert.equal(sent, 0);
});

test('cancelled preparation still releases its owned remote sentinel', async (t) => {
  const machine = 'prepare-cleanup-node';
  const commands: string[] = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    send(raw: string, callback?: () => void) {
      const { id, params } = JSON.parse(raw);
      commands.push(params.cmd);
      callback?.();
      handleNodeResponse(id, true, { exitCode: 0, stdout: '', stderr: '' });
    },
  });
  const ws = socket as WebSocket;
  registerNode(machine, 1, ws);
  t.after(() => unregisterByWs(ws));
  const vars: SlotVars = {
    slotId: 'prepare-slot',
    machine,
    platform: 'cli',
    host: 'remote.invalid',
    sshUser: 'fixture',
    osType: 'macos',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/source',
    session: 'fixture',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: '',
    remoteRepo: '/source',
    projectName: 'fixture',
    resourceVars: {},
  };
  await withNodeReconnectWait(
    async () => {
      await releasePrepareSentinel(
        { vars, lockDir: '/source/.agent', lockPath: '/source/.agent/.preparing.lock' },
        new Error('cancelled'),
      );
    },
    () => {
      throw new Error('Run stopped while awaiting its execution node');
    },
  );
  assert.equal(commands.length, 1);
  assert.match(commands[0], /rm -rf.*\.preparing\.lock/);
});
