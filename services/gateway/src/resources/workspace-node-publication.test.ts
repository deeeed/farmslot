import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { type ResourceKey, resourceKeyId } from '@farmslot/protocol/client-cache';

import '../runtime/mock-pty.test-support.js';

import { getNode, registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import { handleNodeResponse } from '../fleet/node-rpc.js';

import { resourceRevisions } from './revisions.js';
import { acceptWorkspaceSourceEvent, armNodeWorkspace } from './workspace-node-observations.js';
import { WorkspaceObservations } from './workspace-observations.js';

test('current node workspace receipts publish both opened aliases; foreign and replaced sockets cannot write them', async (t) => {
  const machine = 'workspace-ingress-proof';
  const root = '/private-remote-workspace';
  let requestId = '';
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    send(raw: string) {
      const frame = JSON.parse(raw) as { id: string; method: string };
      if (frame.method === 'fs.watch') requestId = frame.id;
      assert(['fs.watch', 'fs.watch.stop'].includes(frame.method));
      handleNodeResponse(frame.id, true, { workspace: 1, ready: true }, undefined, undefined, ws);
    },
  }) as unknown as WebSocket;
  const replacement = Object.assign(new EventEmitter(), { readyState: 1 }) as WebSocket;
  const owner = new WorkspaceObservations();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    owner.release('remote-proof');
    unregisterByWs(ws);
    unregisterByWs(replacement);
    resourceRevisions.dispose();
    resourceRevisions.setPublisher(() => {});
    t.mock.timers.reset();
  });
  registerNode(
    machine,
    1,
    ws,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    { workspace: 1 },
    () => true,
  );
  // Retire unrelated node-registration publications before observing workspace writes.
  resourceRevisions.dispose();
  const node = getNode(machine)!;
  const expected: ResourceKey[] = [
    { family: 'workspace', slotId: 'remote-slot' },
    { family: 'workspace', slotId: 'remote-slot', runId: 'remote-run' },
  ];
  const packets: ResourceKey[] = [];
  resourceRevisions.setPublisher((packet) => packets.push(...packet.changes.map((c) => c.key)));
  const capture = () =>
    owner.capture({
      root,
      sourceId: 'remote-proof',
      keys: expected,
      current: async () => getNode(machine) === node,
      arm: (changed, failed) => armNodeWorkspace(node, root, changed, failed),
    });
  const published = async (changed: boolean) => {
    await Promise.resolve();
    t.mock.timers.tick(201);
    assert.deepEqual(
      packets.map(resourceKeyId).sort(),
      changed ? expected.map(resourceKeyId).sort() : [],
    );
    packets.length = 0;
  };
  const held = await capture();
  const receipt = { workspace: 1, machine, path: root, requestId, kind: 'updated' };
  assert.equal(acceptWorkspaceSourceEvent(replacement, receipt), true);
  await published(false);
  await held();
  assert.equal(acceptWorkspaceSourceEvent(ws, receipt), true);
  await published(true);
  await assert.rejects(held(), /changed during/);
  const fresh = await capture();
  acceptWorkspaceSourceEvent(ws, { ...receipt, kind: 'error', error: { message: 'source lost' } });
  await published(true);
  await assert.rejects(fresh(), /changed during/);
  const recovered = await capture();
  await recovered();
  registerNode(machine, 2, replacement);
  resourceRevisions.dispose();
  acceptWorkspaceSourceEvent(ws, { ...receipt, requestId });
  await published(true); // Current source is invalidated once when its authority changes.
  acceptWorkspaceSourceEvent(ws, { ...receipt, requestId });
  await published(false);
  await assert.rejects(recovered(), /changed during/);
});
