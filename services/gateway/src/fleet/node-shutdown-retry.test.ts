import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import { registerNode, unregisterByWs } from './machine-registry.js';
import {
  handleNodeResponse,
  isNodeConnected,
  isNodeTransportUnavailableError,
  nodeExec,
  sendNodeRequest,
  withNodeReconnectWait,
} from './node-rpc.js';

interface Request {
  id: string;
  method: string;
  params: { cmd?: string };
}
const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function socket(send: (raw: string) => void): WebSocket {
  return Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    send(raw: string, callback?: (error?: Error) => void) {
      send(raw);
      callback?.();
    },
  }) as WebSocket;
}
function register(machine: string, ws: WebSocket): void {
  registerNode(machine, 1, ws, undefined, undefined, undefined, undefined, undefined, true);
}

test('shutdown admission rejection waits for replacement without closing accepted work', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const machine = 'shutdown-read';
  let acceptedId = '';
  let oldReads = 0;
  let newReads = 0;
  const old = socket((raw) => {
    const request: Request = JSON.parse(raw);
    if (request.method === 'exec') {
      acceptedId = request.id;
      return;
    }
    oldReads++;
    handleNodeResponse(request.id, false, undefined, 'Stopping', 'NODE_SHUTTING_DOWN', old);
  });
  const replacement = socket((raw) => {
    const request: Request = JSON.parse(raw);
    newReads++;
    handleNodeResponse(request.id, true, { exists: true }, undefined, undefined, replacement);
  });
  register(machine, old);
  t.after(() => {
    if (acceptedId)
      handleNodeResponse(
        acceptedId,
        true,
        { exitCode: 0, stdout: 'closed', stderr: '' },
        undefined,
        undefined,
        old,
      );
    old.emit('close');
    replacement.emit('close');
    unregisterByWs(old);
    unregisterByWs(replacement);
  });
  const accepted = nodeExec(machine, 'accepted', undefined, {
    noRetry: true,
    signal: new AbortController().signal,
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await drain();
  assert(acceptedId);
  const read = withNodeReconnectWait(
    () => sendNodeRequest({ machine, pid: 1, connectedAt: 'now', ws: old }, 'fs.exists', {}),
    () => {},
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await drain();
  assert.equal(
    isNodeConnected(machine),
    false,
    'an open but stopping socket cannot accept new work',
  );
  assert.equal(old.readyState, WebSocket.OPEN, 'accepted command closeout keeps its connection');
  assert.equal(oldReads, 1);
  assert.equal(newReads, 0);
  register(machine, replacement);
  t.mock.timers.tick(100);
  assert.deepEqual(await read, { value: { exists: true } });
  assert.equal(newReads, 1);
  handleNodeResponse(
    acceptedId,
    true,
    { exitCode: 0, stdout: 'closed', stderr: '' },
    undefined,
    undefined,
    old,
  );
  assert.deepEqual(await accepted, { value: { exitCode: 0, stdout: 'closed', stderr: '' } });
});

test('a noRetry command rejected before execution can run once on the replacement', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const machine = 'shutdown-exec';
  let accepted = 0;
  const old = socket((raw) =>
    handleNodeResponse(JSON.parse(raw).id, false, undefined, 'Stopping', 'NODE_SHUTTING_DOWN', old),
  );
  const replacement = socket((raw) => {
    accepted++;
    handleNodeResponse(
      JSON.parse(raw).id,
      true,
      { exitCode: 0, stdout: 'once', stderr: '' },
      undefined,
      undefined,
      replacement,
    );
  });
  register(machine, old);
  t.after(() => {
    old.emit('close');
    replacement.emit('close');
    unregisterByWs(old);
    unregisterByWs(replacement);
  });
  const pending = withNodeReconnectWait(
    () => nodeExec(machine, 'mutate-once', undefined, { noRetry: true }),
    () => {},
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await drain();
  assert.equal(accepted, 0);
  register(machine, replacement);
  t.mock.timers.tick(100);
  assert.deepEqual(await pending, { value: { exitCode: 0, stdout: 'once', stderr: '' } });
  assert.equal(accepted, 1);
});

test('connection-bound native mutations are never automatically replayed', async (t) => {
  let requests = 0;
  const machine = 'shutdown-native';
  const old = socket((raw) => {
    requests++;
    handleNodeResponse(JSON.parse(raw).id, false, undefined, 'Stopping', 'NODE_SHUTTING_DOWN', old);
  });
  register(machine, old);
  t.after(() => unregisterByWs(old));
  await assert.rejects(
    withNodeReconnectWait(
      () =>
        sendNodeRequest(
          { machine, pid: 1, connectedAt: 'now', ws: old },
          'native.session',
          {},
          { requireSameConnection: true },
        ),
      () => {},
    ),
    (error) => isNodeTransportUnavailableError(error),
  );
  assert.equal(requests, 1);
});

test('ownership change while awaiting replacement prevents the rejected request resend', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const machine = 'shutdown-cancel';
  let current = true;
  let sends = 0;
  const old = socket((raw) =>
    handleNodeResponse(JSON.parse(raw).id, false, undefined, 'Stopping', 'NODE_SHUTTING_DOWN', old),
  );
  const replacement = socket(() => {
    sends++;
  });
  register(machine, old);
  t.after(() => {
    unregisterByWs(old);
    unregisterByWs(replacement);
  });
  const pending = withNodeReconnectWait(
    () => sendNodeRequest({ machine, pid: 1, connectedAt: 'now', ws: old }, 'fs.exists', {}),
    () => {
      if (!current) throw new Error('Run ownership changed');
    },
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await drain();
  current = false;
  register(machine, replacement);
  t.mock.timers.tick(100);
  const result = await pending;
  assert('error' in result);
  assert.match(result.error.message, /Run ownership changed/);
  assert.equal(sends, 0);
});

test('a stopping node replacement wait is bounded by the existing reconnect budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const machine = 'shutdown-offline';
  let sends = 0;
  const old = socket((raw) => {
    sends++;
    handleNodeResponse(JSON.parse(raw).id, false, undefined, 'Stopping', 'NODE_SHUTTING_DOWN', old);
  });
  register(machine, old);
  t.after(() => unregisterByWs(old));
  const pending = withNodeReconnectWait(
    () => sendNodeRequest({ machine, pid: 1, connectedAt: 'now', ws: old }, 'fs.exists', {}),
    () => {},
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await drain();
  t.mock.timers.tick(120000);
  const result = await pending;
  assert('error' in result);
  assert(isNodeTransportUnavailableError(result.error));
  assert.equal(sends, 1, 'no new request was accepted or resent without a replacement');
});

test('a shutdown code from another socket cannot retire this node or authorize a resend', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const machine = 'shutdown-foreign';
  const other = socket(() => {});
  const old = socket((raw) =>
    handleNodeResponse(
      JSON.parse(raw).id,
      false,
      undefined,
      'Stopping',
      'NODE_SHUTTING_DOWN',
      other,
    ),
  );
  register(machine, old);
  t.after(() => unregisterByWs(old));
  const pending = sendNodeRequest(
    { machine, pid: 1, connectedAt: 'now', ws: old },
    'fs.exists',
    {},
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await drain();
  t.mock.timers.tick(15000);
  const result = await pending;
  assert('error' in result);
  assert.equal(isNodeTransportUnavailableError(result.error), false);
  assert.equal(isNodeConnected(machine), true);
});

test('cancellation while waiting for replacement prevents a rejected exec from being submitted', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const machine = 'shutdown-exec-cancel';
  const controller = new AbortController();
  let sends = 0;
  const old = socket((raw) =>
    handleNodeResponse(JSON.parse(raw).id, false, undefined, 'Stopping', 'NODE_SHUTTING_DOWN', old),
  );
  const replacement = socket(() => {
    sends++;
  });
  register(machine, old);
  t.after(() => {
    unregisterByWs(old);
    unregisterByWs(replacement);
  });
  const pending = withNodeReconnectWait(
    () =>
      nodeExec(machine, 'do-not-run', undefined, {
        noRetry: true,
        signal: controller.signal,
      }),
    () => {},
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await drain();
  controller.abort();
  register(machine, replacement);
  t.mock.timers.tick(100);
  const result = await pending;
  assert('error' in result);
  assert.match(result.error.message, /cancelled/);
  assert.equal(sends, 0);
});

test('requests outside an owned reconnect scope report rejection without replaying', async (t) => {
  const machine = 'shutdown-unscoped';
  let sends = 0;
  const old = socket((raw) => {
    sends++;
    handleNodeResponse(JSON.parse(raw).id, false, undefined, 'Stopping', 'NODE_SHUTTING_DOWN', old);
  });
  register(machine, old);
  t.after(() => unregisterByWs(old));
  await assert.rejects(
    sendNodeRequest({ machine, pid: 1, connectedAt: 'now', ws: old }, 'fs.write', {}),
    (error) => isNodeTransportUnavailableError(error),
  );
  assert.equal(sends, 1);
});
