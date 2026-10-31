import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import { handleNodeResponse } from '../fleet/node-rpc.js';

import {
  terminalWorkerInput,
  terminalWorkerResize,
  terminalWorkerSnapshot,
  terminalWorkerSubscribe,
  terminalWorkerUnsubscribeKey,
} from './terminal-worker.js';

function fakeNode(methodReplies: Record<string, unknown>, id?: string) {
  const sent: Array<{ id: string; method: string; params: unknown }> = [];
  const ws = {
    readyState: 1 as number,
    send(raw: string) {
      const frame = JSON.parse(raw) as { id: string; method: string; params: unknown };
      sent.push(frame);
      queueMicrotask(() => {
        const reply = methodReplies[frame.method];
        if (reply instanceof Error) handleNodeResponse(frame.id, false, undefined, reply.message);
        else handleNodeResponse(frame.id, true, reply);
      });
    },
  };
  const nodeId = id ?? `test-node-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  registerNode(nodeId, 1234, ws as never, '0.6.0', '0.6.0');
  return { nodeId, sent, ws };
}

test('worker terminal snapshot/input/resize route to node tmux RPC by worker ref', async () => {
  const node = fakeNode({
    'tmux.capture': { lines: ['hello'] },
    'tmux.send': { sent: true },
    'tmux.resize': { resized: true },
  });
  const worker = { nodeId: node.nodeId, session: 's', window: '0', pane: '0', target: '%42' };

  try {
    const snapshot = await terminalWorkerSnapshot({ worker, lines: 5 });
    assert.deepEqual(snapshot.worker, worker);
    assert.deepEqual(snapshot.lines, ['hello']);
    assert.equal(typeof snapshot.timestamp, 'number');
    await terminalWorkerInput({ worker, data: 'ls\r' });
    await terminalWorkerResize({ worker, cols: 100, rows: 30 });

    assert.deepEqual(
      node.sent.map((frame) => ({ method: frame.method, params: frame.params })),
      [
        { method: 'tmux.capture', params: { session: '%42', lines: 5 } },
        { method: 'tmux.send', params: { session: '%42', text: 'ls\r', enter: false } },
        { method: 'tmux.resize', params: { target: '%42', cols: 100, rows: 30 } },
      ],
    );
  } finally {
    unregisterByWs(node.ws as never);
  }
});

// A batch the phone resends after a lost reply must not be typed into the pane twice.
test('worker terminal input writes each sequenced batch once', async () => {
  const node = fakeNode({ 'tmux.send': { sent: true } });
  const worker = { nodeId: node.nodeId, session: 's', window: '0', pane: '0', target: '%43' };
  try {
    await terminalWorkerInput({ worker, data: 'make deploy\r', seq: { stream: 'q1', n: 1 } });
    await terminalWorkerInput({ worker, data: 'make deploy\r', seq: { stream: 'q1', n: 1 } });
    await terminalWorkerInput({ worker, data: 'ls\r', seq: { stream: 'q1', n: 2 } });
    assert.deepEqual(
      node.sent.map((frame) => (frame.params as { text: string }).text),
      ['make deploy\r', 'ls\r'],
    );
  } finally {
    unregisterByWs(node.ws as never);
  }
});

// Input that never left the gateway (its node was gone) is written by the resend once it is back.
test('worker input refused for a disconnected node is written by its resend', async () => {
  const nodeId = `test-node-gone-${Date.now()}`;
  const worker = { nodeId, session: 's', window: '0', pane: '0', target: '%44' };
  await assert.rejects(
    terminalWorkerInput({ worker, data: 'ls\r', seq: { stream: 'q2', n: 1 } }),
    /not connected/,
  );
  const node = fakeNode({ 'tmux.send': { sent: true } }, nodeId);
  try {
    await terminalWorkerInput({ worker, data: 'ls\r', seq: { stream: 'q2', n: 1 } });
    assert.deepEqual(
      node.sent.map((frame) => (frame.params as { text: string }).text),
      ['ls\r'],
    );
  } finally {
    unregisterByWs(node.ws as never);
  }
});

// A node still registered while its socket closes: nothing left the gateway, so nothing is uncertain.
test('worker input refused by a closing node socket is written by its resend', async () => {
  const node = fakeNode({ 'tmux.send': { sent: true } });
  const worker = { nodeId: node.nodeId, session: 's', window: '0', pane: '0', target: '%45' };
  try {
    node.ws.readyState = 2;
    await assert.rejects(
      terminalWorkerInput({ worker, data: 'pwd\r', seq: { stream: 'q3', n: 1 } }),
    );
    node.ws.readyState = 1;
    await terminalWorkerInput({ worker, data: 'pwd\r', seq: { stream: 'q3', n: 1 } });
    assert.deepEqual(
      node.sent.map((frame) => (frame.params as { text: string }).text),
      ['pwd\r'],
    );
  } finally {
    unregisterByWs(node.ws as never);
  }
});

test('worker terminal subscribe requires pool config before PTY attach', async () => {
  const node = fakeNode({});
  const worker = { nodeId: node.nodeId, session: 's', window: '0', pane: '0', target: '%43' };

  try {
    await assert.rejects(
      () => terminalWorkerSubscribe({ worker, lines: 10 }, () => undefined),
      /pool config for tmux worker node .* was not found/,
    );
    assert.equal(terminalWorkerUnsubscribeKey({ worker }), `${node.nodeId}:%43`);
  } finally {
    unregisterByWs(node.ws as never);
  }
});
