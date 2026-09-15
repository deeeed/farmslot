import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocket } from 'ws';

import {
  handleNodeResponse,
  isNodeTransportUnavailableError,
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
