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

function fakeNode(methodReplies: Record<string, unknown>) {
  const sent: Array<{ id: string; method: string; params: unknown }> = [];
  const ws = {
    readyState: 1,
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
  const nodeId = `test-node-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
