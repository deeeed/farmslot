import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocket } from 'ws';

import { handleNodeResponse, sendNodeRequest } from './node-rpc.js';

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
