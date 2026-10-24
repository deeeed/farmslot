import assert from 'node:assert/strict';
import test from 'node:test';

import type { WebSocket } from 'ws';

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
  registerNode(machine, 100, first, 'old-version', 'current-version');
  const initial = await readWithResourceState(keys!, async () => ({ nodes: getAllNodes() }));
  assert.equal(initial.resourceState.dependencies[0].revision, before + 1);
  assert.equal(initial.payload.nodes.find((node) => node.machine === machine)?.pid, 100);
  await publication(true);
  registerNode(machine, 200, replacement, 'current-version', 'current-version');
  const changed = await readWithResourceState(keys!, async () => ({ nodes: getAllNodes() }));
  assert.equal(changed.resourceState.dependencies[0].revision, before + 2);
  const current = changed.payload.nodes.find((node) => node.machine === machine)!;
  assert.equal(current.pid, 200);
  assert.equal(current.versionMatch, true);
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
