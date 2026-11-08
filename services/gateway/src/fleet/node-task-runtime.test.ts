import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import type { RequestFrame } from '@farmslot/protocol';

import { registerNode, unregisterByWs } from './machine-registry.js';
import { handleNodeResponse, NodeExecUnconfirmedError, nodeTaskRuntime } from './node-rpc.js';

const request = {
  action: 'verify' as const,
  taskPath: '/checkout/tasks/task',
  supportDir: '/captured',
  env: {},
};

async function connection(t: TestContext, cancellable = true, taskRuntime = true) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const connected = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const [peer] = await connected;
  assert(peer instanceof WebSocket);
  await once(client, 'open');
  registerNode(
    'task-runtime-fixture',
    1,
    client,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    cancellable,
    undefined,
    undefined,
    undefined,
    undefined,
    { node: {}, taskRuntime: taskRuntime ? 1 : undefined },
  );
  t.after(() => {
    unregisterByWs(client);
    client.terminate();
    peer.terminate();
    server.close();
  });
  return { client, peer };
}

async function received(peer: WebSocket): Promise<RequestFrame> {
  const [raw] = await once(peer, 'message');
  return JSON.parse(String(raw));
}

test('task libraries execute once on the node and retain the exec result unchanged', async (t) => {
  const { client, peer } = await connection(t);
  const incoming = received(peer);
  const reply = nodeTaskRuntime('task-runtime-fixture', request, 120_000);
  const sent = await incoming;
  assert.equal(sent.method, 'task.runtime');
  assert.deepEqual(sent.params, { ...request, requestScoped: true });
  const result = { exitCode: 5, stdout: 'retained refusal', stderr: 'diagnostic' };
  handleNodeResponse(sent.id, true, result, undefined, undefined, client);
  assert.deepEqual(await reply, result);
});

test('task cancellation waits for the original worker result', async (t) => {
  const { client, peer } = await connection(t);
  const controller = new AbortController();
  const incoming = received(peer);
  const reply = nodeTaskRuntime('task-runtime-fixture', request, 120_000, controller.signal);
  const sent = await incoming;
  const cancellation = received(peer);
  controller.abort();
  const cancel = await cancellation;
  assert.equal(cancel.method, 'exec.cancel');
  assert.deepEqual(cancel.params, { requestId: sent.id });
  const result = { exitCode: 130, stdout: '', stderr: 'cancelled' };
  handleNodeResponse(sent.id, true, result, undefined, undefined, client);
  assert.deepEqual(await reply, result);
});

test('a lost task reply is uncertain and never reruns initialization', async (t) => {
  const { client, peer } = await connection(t);
  const incoming = received(peer);
  const reply = nodeTaskRuntime('task-runtime-fixture', { ...request, action: 'init' }, 600_000);
  const rejection = assert.rejects(reply, NodeExecUnconfirmedError);
  const sent = await incoming;
  assert.equal(sent.method, 'task.runtime');
  client.emit('close');
  await rejection;
});

test('task execution refuses a node without owned cancellation before sending', async (t) => {
  await connection(t, false);
  await assert.rejects(
    nodeTaskRuntime('task-runtime-fixture', request, 120_000),
    /needs an update/,
  );
});

test('task execution rechecks the connected node capability before sending', async (t) => {
  const { client } = await connection(t, true, false);
  const send = t.mock.method(client, 'send', () => {
    throw new Error('Unexpected task.runtime send to an unsupported node');
  });
  await assert.rejects(
    nodeTaskRuntime('task-runtime-fixture', request, 120_000),
    /does not advertise task.runtime/,
  );
  assert.equal(send.mock.callCount(), 0);
});
