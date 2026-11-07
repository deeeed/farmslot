import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocket } from 'ws';

import {
  resourceDependenciesForRead,
  type ResourceKey,
  resourceKeyId,
} from '@farmslot/protocol/client-cache';

import { readWithResourceState, resourceRevisions } from '../resources/revisions.js';

import { getAllNodes, registerNode, unregisterByWs } from './machine-registry.js';

test('node inventory commits stamp replacements and removals; an old transport cannot remove its replacement', async (t) => {
  const machine = 'inventory-observation-proof';
  const first = {} as WebSocket;
  const replacement = {} as WebSocket;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    unregisterByWs(first);
    unregisterByWs(replacement);
    resourceRevisions.dispose();
    resourceRevisions.setPublisher(() => {});
    t.mock.timers.reset();
  });
  const published: ResourceKey[] = [];
  resourceRevisions.setPublisher((packet) => {
    published.push(...packet.changes.map((change) => change.key));
  });
  const expected: ResourceKey[] = [
    { family: 'node', scope: 'farm' },
    { family: 'node', nodeId: machine },
    { family: 'workers', scope: 'farm' },
    { family: 'workers', nodeId: machine },
  ];
  const publication = async (changed: boolean) => {
    await Promise.resolve();
    t.mock.timers.tick(201);
    assert.deepEqual(
      published.map(resourceKeyId).sort(),
      changed ? expected.map(resourceKeyId).sort() : [],
    );
    published.length = 0;
  };
  const keys = resourceDependenciesForRead('nodes.list', {});
  assert.deepEqual(keys, [{ family: 'node', scope: 'farm' }]);
  const key = keys![0];
  const before = resourceRevisions.revision(key);
  registerNode(machine, 100, first, '0.76.0', '0.77.0');
  const initial = await readWithResourceState(keys!, async () => ({ nodes: getAllNodes() }));
  assert.equal(initial.resourceState.dependencies[0].revision, before + 1);
  assert.equal(initial.payload.nodes.find((node) => node.machine === machine)?.pid, 100);
  await publication(true);
  registerNode(machine, 200, replacement, '0.77.0', '0.77.0');
  const changed = await readWithResourceState(keys!, async () => ({ nodes: getAllNodes() }));
  assert.equal(changed.resourceState.dependencies[0].revision, before + 2);
  const current = changed.payload.nodes.find((node) => node.machine === machine)!;
  assert.equal(current.pid, 200);
  assert.equal(current.versionMatch, undefined, 'Legacy undeclared floors stay unverified');
  await publication(true);
  assert.equal(unregisterByWs(first), null);
  assert.equal(resourceRevisions.revision(key), before + 2);
  await publication(false);
  assert.equal(unregisterByWs(replacement), machine);
  const removed = await readWithResourceState(keys!, async () => ({ nodes: getAllNodes() }));
  assert.equal(removed.resourceState.dependencies[0].revision, before + 3);
  assert(!removed.payload.nodes.some((node) => node.machine === machine));
  await publication(true);
  assert.equal(unregisterByWs(replacement), null);
  assert.equal(resourceRevisions.revision(key), before + 3);
  await publication(false);
});

for (const [gateway, node] of [
  ['0.76.0', '0.77.0'],
  ['0.77.0', '0.76.0'],
]) {
  test(`node inventory accepts compatible gateway ${gateway} / node ${node}`, (t) => {
    // ws's server-side null constructor requires options beyond its public overload.
    const socket: unknown = Reflect.construct(WebSocket, [null, undefined, { autoPong: true }]);
    assert(socket instanceof WebSocket);
    const machine = 'declared-peer-compatibility';
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => {
      unregisterByWs(socket);
      resourceRevisions.dispose();
      t.mock.timers.reset();
    });
    const versions = (protocolVersion: string) => ({
      protocolVersion,
      minimumProtocolVersion: '0.76.0',
      runtimeVersion: '0.43.0',
      minimumRuntimeVersion: '0.42.0',
    });
    registerNode(
      machine,
      1,
      socket,
      node,
      gateway,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { node: versions(node), gateway: versions(gateway) },
    );
    const info = getAllNodes().find((entry) => entry.machine === machine)!;
    assert.equal(info.versionMatch, true);
    assert.equal(info.minimumProtocolVersion, '0.76.0');
    assert.equal(info.runtimeVersion, '0.43.0');
    assert.equal(info.minimumRuntimeVersion, '0.42.0');
  });
}
