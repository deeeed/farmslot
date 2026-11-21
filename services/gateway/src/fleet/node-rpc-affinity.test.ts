import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket } from 'ws';

import { type ConnectedNode, registerNode, unregisterByWs } from './machine-registry.js';
import {
  failRequestsBoundTo,
  handleNodeExecOutput,
  handleNodeResponse,
  nodeExec,
  NodeExecUnconfirmedError,
  NodeTransportUnavailableError,
  sendNodeRequest,
} from './node-rpc.js';

test('a connection-bound native request ignores another node reply with the same request id', async () => {
  let id = '';
  const expected = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      id = JSON.parse(raw).id;
    },
  } as WebSocket;
  const other = {} as WebSocket;
  const reply = sendNodeRequest(
    { machine: 'node-a', pid: 1, connectedAt: new Date().toISOString(), ws: expected },
    'native.session',
    {},
    { requireSameConnection: true, timeout: 1000 },
  );
  let settled = false;
  void reply.then(() => {
    settled = true;
  });
  handleNodeResponse(id, true, 'wrong-node', undefined, undefined, other);
  await Promise.resolve();
  assert.equal(settled, false);
  handleNodeResponse(id, true, 'expected-node', undefined, undefined, expected);
  assert.equal(await reply, 'expected-node');
});

test('a closed connection fails its bound requests at once and leaves unbound ones answerable', async () => {
  // Run 8cff6e80: a node restart left a bound chunk read waiting out its timeout.
  const socket = new ExecSocket();
  const node = {
    machine: 'node-a',
    pid: 1,
    connectedAt: new Date().toISOString(),
    ws: socket.asSocket(),
  };
  const bound = sendNodeRequest(node, 'fs.readChunk', {}, { requireSameConnection: true });
  const unbound = sendNodeRequest(node, 'fs.stat', {}, { timeout: 1000 });
  const unboundId = socket.sent[1]!.id;

  // The gateway's connection close handler.
  failRequestsBoundTo(socket.asSocket());

  await assert.rejects(
    bound,
    (error: unknown) =>
      error instanceof NodeTransportUnavailableError && error.reason === 'disconnected',
  );
  // The node may still answer an unbound request on its new connection.
  handleNodeResponse(unboundId, true, 'answered', undefined, undefined, {} as WebSocket);
  assert.equal(await unbound, 'answered');
});

interface SentRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}
class ExecSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: SentRequest[] = [];
  send(raw: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(raw));
    callback?.();
  }
  asSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

async function startScopedExec(
  t: test.TestContext,
  socket: ExecSocket,
  onDispatch?: (node: ConnectedNode) => void,
) {
  const controller = new AbortController();
  const output: string[] = [];
  registerNode(
    'owned-exec-fixture',
    1,
    socket.asSocket(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  t.after(() => {
    socket.emit('close');
    unregisterByWs(socket.asSocket());
  });
  const result = nodeExec('owned-exec-fixture', 'recipe-command', '/checkout', {
    signal: controller.signal,
    timeout: 1000,
    closeoutTimeoutMs: 10,
    onOutput: (_stream, data) => output.push(data),
    onDispatch,
  });
  // waitForNode resolves the registered socket before sending in the next microtask.
  await Promise.resolve();
  return { controller, result, output, request: socket.sent[0]! };
}

test('remote exec waits for send acceptance and never reports a failed send', async (t) => {
  const socket = new ExecSocket();
  let acknowledge: ((error?: Error) => void) | undefined;
  t.mock.method(socket, 'send', (raw: string, callback?: (error?: Error) => void) => {
    socket.sent.push(JSON.parse(raw));
    acknowledge = callback;
  });
  const dispatches: ConnectedNode[] = [];
  const { result } = await startScopedExec(t, socket, (node) => dispatches.push(node));
  assert.equal(socket.sent[0]?.method, 'exec');
  assert.ok(acknowledge);
  const rejected = assert.rejects(result, NodeExecUnconfirmedError);
  const before = dispatches.length;
  acknowledge(new Error('fixture write failure'));
  await rejected;
  assert.equal(before, 0);
  assert.deepEqual(dispatches, []);
});

test('an RPC reports no send acceptance when the socket write fails', async (t) => {
  const socket = new ExecSocket();
  const error = new Error('fixture write failure');
  t.mock.method(socket, 'send', (_raw: string, callback?: (failure?: Error) => void) => {
    queueMicrotask(() => callback?.(error));
  });
  let accepted = 0;
  await assert.rejects(
    sendNodeRequest(
      { machine: 'node-a', pid: 1, connectedAt: new Date().toISOString(), ws: socket.asSocket() },
      'node.link.command',
      {},
      { requireSameConnection: true, timeout: 100, onSent: () => accepted++ },
    ),
    (failure: unknown) => {
      assert(failure instanceof NodeTransportUnavailableError);
      assert.equal(failure.reason, 'disconnected');
      assert.equal(failure.cause, error);
      return true;
    },
  );
  assert.equal(accepted, 0);
});

test(
  'exec cancellation stays on its connection and settles only with the original result',
  { timeout: 4000 },
  async (t) => {
    const socket = new ExecSocket();
    const { controller, result, output, request } = await startScopedExec(t, socket);
    assert.equal(request.params.requestScoped, true);
    let settled = false;
    const observed = result.then((value) => {
      settled = true;
      return value;
    });
    const other = new ExecSocket().asSocket();
    handleNodeExecOutput(request.id, 'stdout', 'foreign', other);
    handleNodeResponse(request.id, true, 'foreign', undefined, undefined, other);
    handleNodeExecOutput(request.id, 'stdout', 'owned', socket.asSocket());
    assert.deepEqual(output, ['owned']);
    controller.abort();
    const cancel = socket.sent[1]!;
    assert.equal(cancel.method, 'exec.cancel');
    assert.equal(cancel.params.requestId, request.id);
    handleNodeResponse(
      cancel.id,
      true,
      { cancelled: true },
      undefined,
      undefined,
      socket.asSocket(),
    );
    await Promise.resolve();
    assert.equal(settled, false, 'cancellation acknowledgement is not process closeout');
    handleNodeResponse(
      request.id,
      true,
      { stdout: 'owned', stderr: '', exitCode: 130 },
      undefined,
      undefined,
      socket.asSocket(),
    );
    assert.equal((await observed).exitCode, 130);
    assert.equal(socket.listenerCount('close'), 0);
    assert.equal(socket.sent.filter((frame) => frame.method === 'exec').length, 1);
  },
);

test(
  'lost execution replies remain unconfirmed and are never retried on a replacement node',
  { timeout: 4000 },
  async (t) => {
    const socket = new ExecSocket();
    const { result, request } = await startScopedExec(t, socket);
    const refusal = assert.rejects(result, (error: unknown) => {
      assert(error instanceof NodeExecUnconfirmedError);
      assert.equal(error.requestId, request.id);
      assert.equal(error.executionConnection, socket.asSocket());
      return true;
    });
    const replacement = new ExecSocket();
    registerNode(
      'owned-exec-fixture',
      2,
      replacement.asSocket(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    t.after(() => unregisterByWs(replacement.asSocket()));
    socket.emit('close');
    await refusal;
    assert.equal(socket.sent.length, 1);
    assert.equal(replacement.sent.length, 0);
    assert.equal(socket.listenerCount('close'), 0);
  },
);

test(
  'a timed-out execution is confirmed closed only by its late result on its own connection',
  { timeout: 4000 },
  async (t) => {
    // F298: a slow read on a loaded node timed out unconfirmed; the node's later reply proves the
    // process closed, so it must reach the reader that is waiting on that closeout.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const socket = new ExecSocket();
    const { controller, result, request } = await startScopedExec(t, socket);
    controller.abort();
    // The 10 ms closeout window plus the transport grace elapse with no reply.
    t.mock.timers.tick(10_010);
    const error: unknown = await result.catch((failure: unknown) => failure);
    assert(error instanceof NodeExecUnconfirmedError);
    assert.equal(error.reason, 'timeout');
    let confirmed = false;
    void error.closeout.then(() => {
      confirmed = true;
    });
    const late = { stdout: '', stderr: '', exitCode: 130 };
    handleNodeResponse(request.id, true, late, undefined, undefined, new ExecSocket().asSocket());
    await Promise.resolve();
    assert.equal(confirmed, false, 'another connection cannot confirm it');
    handleNodeResponse(request.id, true, late, undefined, undefined, socket.asSocket());
    await error.closeout;
    assert.equal(confirmed, true);
  },
);

test(
  'a closed connection drops the closeout it owed, so a reply after reconnect proves nothing',
  { timeout: 4000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const socket = new ExecSocket();
    const { controller, result, request } = await startScopedExec(t, socket);
    controller.abort();
    t.mock.timers.tick(10_010);
    const error: unknown = await result.catch((failure: unknown) => failure);
    assert(error instanceof NodeExecUnconfirmedError);
    let confirmed = false;
    void error.closeout.then(() => {
      confirmed = true;
    });
    // The gateway's connection close handler.
    failRequestsBoundTo(socket.asSocket());
    handleNodeResponse(request.id, true, { exitCode: 0 }, undefined, undefined, socket.asSocket());
    await Promise.resolve();
    assert.equal(confirmed, false);
  },
);
