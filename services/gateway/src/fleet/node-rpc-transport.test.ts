import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocket } from 'ws';

import { registerNode, unregisterByWs } from './machine-registry.js';
import {
  handleNodeResponse,
  isNodeTransportUnavailableError,
  nodeExec,
  NodeRpcTimeoutError,
  NodeTransportUnavailableError,
  sendNodeRequest,
} from './node-rpc.js';

function node(ws: WebSocket) {
  return { machine: 'transport-fixture', pid: 1, connectedAt: 'now', ws };
}

test('local socket/deadline failures are typed transport uncertainty and preserve timeout compatibility', async () => {
  await assert.rejects(
    sendNodeRequest(node({ readyState: WebSocket.CLOSED } as WebSocket), 'read', {}),
    (error: unknown) => {
      assert(isNodeTransportUnavailableError(error));
      assert.equal(error.reason, 'disconnected');
      assert.match(error.message, /WebSocket not open/);
      return true;
    },
  );
  await assert.rejects(
    sendNodeRequest(
      node({ readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket),
      'read',
      {},
      { timeout: 1 },
    ),
    (error: unknown) => {
      assert(error instanceof NodeRpcTimeoutError);
      assert(isNodeTransportUnavailableError(error));
      assert.equal(error.reason, 'timeout');
      assert.equal(error.timeoutMs, 1);
      assert.equal(error.machine, 'transport-fixture');
      return true;
    },
  );
  assert.equal(
    isNodeTransportUnavailableError(
      new NodeTransportUnavailableError('machine', 'connection-replaced', 'replacement'),
    ),
    true,
  );
});

test('remote codes and messages cannot forge a local transport failure', async () => {
  for (const code of ['NODE_TRANSPORT_UNAVAILABLE', 'AUTH_FORBIDDEN', 'NATIVE_SESSION_ERROR']) {
    const ws = {
      readyState: WebSocket.OPEN,
      send(raw: string) {
        handleNodeResponse(
          JSON.parse(raw).id,
          false,
          undefined,
          'timeout WebSocket not open',
          code,
        );
      },
    } as WebSocket;
    await assert.rejects(sendNodeRequest(node(ws), 'read', {}), (error: unknown) => {
      assert.equal(isNodeTransportUnavailableError(error), false);
      assert.equal((error as { code: string }).code, code);
      return true;
    });
  }
});

test('a noRetry exec is not resent after a lost reply; the default still retries once', async (t) => {
  let sends = 0;
  const ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      sends += 1;
      // The reply never arrives: what a node that dropped mid-request reports.
      handleNodeResponse(JSON.parse(raw).id, false, undefined, 'WebSocket not open');
    },
  } as unknown as WebSocket;
  registerNode('noretry-fixture', 1, ws);
  t.after(() => unregisterByWs(ws));

  await assert.rejects(
    nodeExec('noretry-fixture', 'tmux respawn-window -k', undefined, { noRetry: true }),
    /not open/,
  );
  assert.equal(sends, 1, 'a command that may already have run is not sent again');

  sends = 0;
  await assert.rejects(nodeExec('noretry-fixture', 'true'), /not open/);
  assert.equal(sends, 2);
});
